use ckb_always_success_script::ALWAYS_SUCCESS;
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::TransactionBuilder,
    packed::{CellInput, CellOutput, OutPoint, Script, WitnessArgs},
    prelude::*,
};
use ckb_testtool::context::Context;

const TAG_GAME: u8 = 0x00;
const STATUS_WAITING: u8 = 0;
const STATUS_COMMIT: u8 = 1;
const STATUS_REVEAL: u8 = 2;
const STATUS_FINISHED: u8 = 3;
const DIR_NONE: u8 = 0xFF;
const ROUNDS: u8 = 3;
const BLAKE2B_PERSONAL: &[u8; 16] = b"four-gods-reveal";

#[derive(Clone, Debug)]
struct Player {
    lock_script: Bytes,
    balance: u64,
    bet: u64,
    used_directions: u8,
    commit_hash: [u8; 32],
    revealed_direction: u8,
    survived: bool,
    has_committed: bool,
    has_revealed: bool,
}

impl Player {
    fn new(lock_script: Bytes, balance: u64, bet: u64) -> Self {
        Player {
            lock_script,
            balance,
            bet,
            used_directions: 0,
            commit_hash: [0u8; 32],
            revealed_direction: DIR_NONE,
            survived: true,
            has_committed: false,
            has_revealed: false,
        }
    }
}

#[derive(Clone, Debug)]
struct GameState {
    status: u8,
    min_players: u8,
    max_players: u8,
    num_players: u8,
    round: u8,
    banker_index: u8,
    reveal_cursor: u8,
    timeout_blocks: u64,
    reveal_order: Vec<u8>,
    players: Vec<Player>,
}

impl GameState {
    fn waiting(min: u8, max: u8) -> Self {
        GameState {
            status: STATUS_WAITING,
            min_players: min,
            max_players: max,
            num_players: 0,
            round: 0,
            banker_index: 0,
            reveal_cursor: 0,
            timeout_blocks: 100,
            reveal_order: Vec::new(),
            players: Vec::new(),
        }
    }
}

fn write_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn write_u64(buf: &mut Vec<u8>, v: u64) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn serialize_player(p: &Player) -> Bytes {
    let mut buf = Vec::new();
    write_u16(&mut buf, p.lock_script.len() as u16);
    buf.extend_from_slice(&p.lock_script);
    write_u64(&mut buf, p.balance);
    write_u64(&mut buf, p.bet);
    buf.push(p.used_directions);
    buf.extend_from_slice(&p.commit_hash);
    buf.push(p.revealed_direction);
    buf.push(p.survived as u8);
    buf.push(p.has_committed as u8);
    buf.push(p.has_revealed as u8);
    buf.into()
}

fn serialize_game(g: &GameState) -> Bytes {
    let mut buf = Vec::new();
    buf.push(TAG_GAME);
    buf.push(g.status);
    buf.push(g.min_players);
    buf.push(g.max_players);
    buf.push(g.num_players);
    buf.push(g.round);
    buf.push(g.banker_index);
    buf.push(g.reveal_cursor);
    write_u64(&mut buf, g.timeout_blocks);
    buf.push(g.reveal_order.len() as u8);
    for &i in &g.reveal_order {
        buf.push(i);
    }
    buf.push(g.players.len() as u8);
    for p in &g.players {
        buf.extend_from_slice(&serialize_player(p));
    }
    buf.into()
}

fn hash_reveal(direction: u8, nonce: &[u8]) -> [u8; 32] {
    let mut ctx = blake2b_ref::Blake2bBuilder::new(32)
        .personal(BLAKE2B_PERSONAL)
        .build();
    ctx.update(&[direction]);
    ctx.update(nonce);
    let mut result = [0u8; 32];
    ctx.finalize(&mut result);
    result
}

fn always_success_lock(ctx: &mut Context, args: Bytes) -> Script {
    let out_point = ctx.deploy_cell(Bytes::from_static(ALWAYS_SUCCESS));
    let (_cell, data) = ctx.get_cell(&out_point).unwrap();
    let code_hash = CellOutput::calc_data_hash(&data);
    Script::new_builder()
        .code_hash(code_hash)
        .hash_type(ckb_testtool::ckb_types::core::ScriptHashType::Data1)
        .args(args.pack())
        .build()
}

fn game_type_script(ctx: &mut Context) -> Script {
    let out_point = ctx.deploy_cell_by_name("four-gods");
    ctx.build_script(&out_point, Bytes::new())
        .expect("game type script")
}

fn game_lock_script(ctx: &mut Context) -> Script {
    let out_point = ctx.deploy_cell_by_name("four-gods");
    ctx.build_script(&out_point, Bytes::from(vec![42]))
        .expect("game lock script")
}

fn empty_witness() -> Bytes {
    WitnessArgs::new_builder().build().as_bytes()
}

fn nonce_witness(nonce: &[u8]) -> Bytes {
    WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(nonce.to_vec())).pack())
        .build()
        .as_bytes()
}

fn build_output(
    capacity: u64,
    lock: &Script,
    type_: Option<&Script>,
    data: Bytes,
) -> (CellOutput, Bytes) {
    let mut builder = CellOutput::new_builder().capacity(capacity).lock(lock.clone());
    if let Some(t) = type_ {
        builder = builder.type_(Some(t.clone()).pack());
    }
    (builder.build(), data)
}

fn add_player(state: &mut GameState, player: Player) {
    state.num_players += 1;
    state.players.push(player);
}

fn compute_reveal_order(players: &[Player]) -> Vec<u8> {
    let mut order: Vec<u8> = (0..players.len() as u8).collect();
    order.sort_by(|a, b| {
        let pa = &players[*a as usize];
        let pb = &players[*b as usize];
        pa.bet.cmp(&pb.bet).then_with(|| a.cmp(b))
    });
    order
}

fn fund_cell(ctx: &mut Context, lock: &Script, capacity: u64) -> OutPoint {
    ctx.create_cell(
        CellOutput::new_builder()
            .capacity(capacity)
            .lock(lock.clone())
            .build(),
        Bytes::new(),
    )
}

fn step_transition(
    ctx: &mut Context,
    label: &str,
    inputs: Vec<CellInput>,
    game_output: CellOutput,
    game_data: Bytes,
    other_outputs: Vec<CellOutput>,
    other_outputs_data: Vec<Bytes>,
    witnesses: Vec<Bytes>,
) -> OutPoint {
    let mut outputs = vec![game_output.clone()];
    outputs.extend(other_outputs);
    let mut outputs_data = vec![game_data.clone()];
    outputs_data.extend(other_outputs_data);
    let tx = TransactionBuilder::default()
        .set_inputs(inputs)
        .outputs(outputs)
        .outputs_data(outputs_data.pack())
        .set_witnesses(witnesses.into_iter().map(|b| b.pack()).collect())
        .build();
    let tx = ctx.complete_tx(tx);
    let out_point = tx.output_pts().get(0).unwrap().clone();
    ctx.verify_tx(&tx, 70_000_000).expect(label);
    ctx.create_cell_with_out_point(out_point.clone(), game_output, game_data);
    out_point
}

#[test]
fn test_create_game() {
    let mut context = Context::default();
    let game_type = game_type_script(&mut context);
    let dummy_lock = always_success_lock(&mut context, Bytes::from(vec![0]));

    let funding = fund_cell(&mut context, &dummy_lock, 500_000);
    let state = GameState::waiting(2, 2);
    let (game_out, game_data) = build_output(200_000, &dummy_lock, Some(&game_type), serialize_game(&state));

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .output(game_out)
        .output(CellOutput::new_builder().capacity(300_000).lock(dummy_lock.clone()).build())
        .outputs_data(vec![game_data, Bytes::new()].pack())
        .witness(empty_witness())
        .build();
    let tx = context.complete_tx(tx);
    context.verify_tx(&tx, 70_000_000).expect("create passes");
}

#[test]
fn test_join_game_when_contract_is_lock() {
    let mut context = Context::default();
    let game_lock = game_lock_script(&mut context);
    let host_lock = always_success_lock(&mut context, Bytes::from(vec![0]));

    let mut state = GameState::waiting(2, 2);
    let (game_out, game_data) = build_output(200_000, &game_lock, None, serialize_game(&state));
    let game_out_point = context.create_cell(game_out, game_data);

    add_player(&mut state, Player::new(host_lock.as_bytes(), 200, 200));
    let (game_out, game_data) = build_output(200_200, &game_lock, None, serialize_game(&state));
    let host_fund = fund_cell(&mut context, &host_lock, 200_000);
    let _game_out_point = step_transition(
        &mut context,
        "join host with game contract lock",
        vec![
            CellInput::new_builder()
                .previous_output(game_out_point)
                .build(),
            CellInput::new_builder().previous_output(host_fund).build(),
        ],
        game_out,
        game_data,
        vec![
            CellOutput::new_builder()
                .capacity(199_800)
                .lock(host_lock.clone())
                .build(),
        ],
        vec![Bytes::new()],
        vec![empty_witness(), empty_witness()],
    );
}

#[test]
fn test_full_two_player_game() {
    let mut context = Context::default();
    let game_type = game_type_script(&mut context);
    let game_lock = always_success_lock(&mut context, Bytes::from(vec![99]));
    let host_lock = always_success_lock(&mut context, Bytes::from(vec![0]));
    let guest_lock = always_success_lock(&mut context, Bytes::from(vec![1]));

    let mut state = GameState::waiting(2, 2);
    let (game_out, game_data) = build_output(200_000, &game_lock, Some(&game_type), serialize_game(&state));
    let host_fund_0 = fund_cell(&mut context, &host_lock, 500_000);
    let mut game_out_point = step_transition(
        &mut context,
        "create",
        vec![CellInput::new_builder().previous_output(host_fund_0).build()],
        game_out,
        game_data,
        vec![CellOutput::new_builder().capacity(300_000).lock(host_lock.clone()).build()],
        vec![Bytes::new()],
        vec![empty_witness()],
    );

    // ---- join host ----
    add_player(&mut state, Player::new(host_lock.as_bytes(), 200, 200));
    let (game_out, game_data) = build_output(200_200, &game_lock, Some(&game_type), serialize_game(&state));
    let host_fund_join = fund_cell(&mut context, &host_lock, 200_000);
    game_out_point = step_transition(
        &mut context,
        "join host",
        vec![
            CellInput::new_builder().previous_output(game_out_point).build(),
            CellInput::new_builder().previous_output(host_fund_join).build(),
        ],
        game_out,
        game_data,
        vec![CellOutput::new_builder().capacity(199_800).lock(host_lock.clone()).build()],
        vec![Bytes::new()],
        vec![empty_witness(), empty_witness()],
    );

    // ---- join guest ----
    add_player(&mut state, Player::new(guest_lock.as_bytes(), 100, 100));
    let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
    let guest_fund_0 = fund_cell(&mut context, &guest_lock, 200_000);
    game_out_point = step_transition(
        &mut context,
        "join guest",
        vec![
            CellInput::new_builder().previous_output(game_out_point).build(),
            CellInput::new_builder().previous_output(guest_fund_0).build(),
        ],
        game_out,
        game_data,
        vec![CellOutput::new_builder().capacity(199_900).lock(guest_lock.clone()).build()],
        vec![Bytes::new()],
        vec![empty_witness(), empty_witness()],
    );

    // ---- start ----
    state.status = STATUS_COMMIT;
    state.reveal_order = compute_reveal_order(&state.players);
    let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
    let host_fund_1 = fund_cell(&mut context, &host_lock, 200_000);
    game_out_point = step_transition(
        &mut context,
        "start",
        vec![
            CellInput::new_builder().previous_output(game_out_point).build(),
            CellInput::new_builder().previous_output(host_fund_1).build(),
        ],
        game_out,
        game_data,
        vec![CellOutput::new_builder().capacity(200_000).lock(host_lock.clone()).build()],
        vec![Bytes::new()],
        vec![empty_witness(), empty_witness()],
    );

    // ---- three rounds ----
    // Guest has lower bet, so reveals first every round.
    let guest_nonces: [&[u8]; 3] = [b"g0", b"g1", b"g2"];
    let host_nonces: [&[u8]; 3] = [b"h0", b"h1", b"h2"];
    let guest_dirs: [u8; 3] = [0, 2, 3];
    let host_dirs: [u8; 3] = [1, 3, 2];

    for round in 0..ROUNDS {
        // commit guest
        state.players[1].commit_hash = hash_reveal(guest_dirs[round as usize], guest_nonces[round as usize]);
        state.players[1].has_committed = true;
        let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
        let gf = fund_cell(&mut context, &guest_lock, 200_000);
        game_out_point = step_transition(
            &mut context,
            "commit guest",
            vec![
                CellInput::new_builder().previous_output(game_out_point).build(),
                CellInput::new_builder().previous_output(gf).build(),
            ],
            game_out,
            game_data,
            vec![CellOutput::new_builder().capacity(200_000).lock(guest_lock.clone()).build()],
            vec![Bytes::new()],
            vec![empty_witness(), empty_witness()],
        );

        // commit host
        state.players[0].commit_hash = hash_reveal(host_dirs[round as usize], host_nonces[round as usize]);
        state.players[0].has_committed = true;
        let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
        let hf = fund_cell(&mut context, &host_lock, 200_000);
        game_out_point = step_transition(
            &mut context,
            "commit host",
            vec![
                CellInput::new_builder().previous_output(game_out_point).build(),
                CellInput::new_builder().previous_output(hf).build(),
            ],
            game_out,
            game_data,
            vec![CellOutput::new_builder().capacity(200_000).lock(host_lock.clone()).build()],
            vec![Bytes::new()],
            vec![empty_witness(), empty_witness()],
        );

        // reveal guest
        state.players[1].revealed_direction = guest_dirs[round as usize];
        state.players[1].has_revealed = true;
        state.players[1].used_directions |= 1u8 << guest_dirs[round as usize];
        state.status = STATUS_REVEAL;
        state.reveal_cursor = 1;
        let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
        let gf = fund_cell(&mut context, &guest_lock, 200_000);
        game_out_point = step_transition(
            &mut context,
            "reveal guest",
            vec![
                CellInput::new_builder().previous_output(game_out_point).build(),
                CellInput::new_builder().previous_output(gf).build(),
            ],
            game_out,
            game_data,
            vec![CellOutput::new_builder().capacity(200_000).lock(guest_lock.clone()).build()],
            vec![Bytes::new()],
            vec![empty_witness(), nonce_witness(guest_nonces[round as usize])],
        );

        // reveal host
        state.players[0].revealed_direction = host_dirs[round as usize];
        state.players[0].has_revealed = true;
        state.players[0].used_directions |= 1u8 << host_dirs[round as usize];
        state.reveal_cursor = 2;
        let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
        let hf = fund_cell(&mut context, &host_lock, 200_000);
        game_out_point = step_transition(
            &mut context,
            "reveal host",
            vec![
                CellInput::new_builder().previous_output(game_out_point).build(),
                CellInput::new_builder().previous_output(hf).build(),
            ],
            game_out,
            game_data,
            vec![CellOutput::new_builder().capacity(200_000).lock(host_lock.clone()).build()],
            vec![Bytes::new()],
            vec![empty_witness(), nonce_witness(host_nonces[round as usize])],
        );

        // resolve round
        if round == ROUNDS - 1 {
            state.players[1].balance += 100;
            state.players[0].balance -= 100;
            state.status = STATUS_FINISHED;
        } else {
            state.status = STATUS_COMMIT;
            state.round += 1;
            state.reveal_cursor = 0;
            state.players[0].commit_hash = [0u8; 32];
            state.players[0].revealed_direction = DIR_NONE;
            state.players[0].has_committed = false;
            state.players[0].has_revealed = false;
            state.players[1].commit_hash = [0u8; 32];
            state.players[1].revealed_direction = DIR_NONE;
            state.players[1].has_committed = false;
            state.players[1].has_revealed = false;
        }
        let (game_out, game_data) = build_output(200_300, &game_lock, Some(&game_type), serialize_game(&state));
        let hf = fund_cell(&mut context, &host_lock, 200_000);
        game_out_point = step_transition(
            &mut context,
            "resolve",
            vec![
                CellInput::new_builder().previous_output(game_out_point).build(),
                CellInput::new_builder().previous_output(hf).build(),
            ],
            game_out,
            game_data,
            vec![CellOutput::new_builder().capacity(200_000).lock(host_lock.clone()).build()],
            vec![Bytes::new()],
            vec![empty_witness(), empty_witness()],
        );
    }

    // ---- finish ----
    assert_eq!(state.players[0].balance, 100);
    assert_eq!(state.players[1].balance, 200);
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(game_out_point).build())
        .output(CellOutput::new_builder().capacity(20_000).lock(host_lock.clone()).build())
        .output(CellOutput::new_builder().capacity(20_000).lock(guest_lock.clone()).build())
        .output(CellOutput::new_builder().capacity(160_300).lock(host_lock.clone()).build())
        .outputs_data(vec![Bytes::new(); 3].pack())
        .witness(empty_witness())
        .build();
    let tx = context.complete_tx(tx);
    context.verify_tx(&tx, 70_000_000).expect("finish passes");
}
