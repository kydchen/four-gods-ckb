#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
ckb_std::default_alloc!(16384, 1258306, 64);

use alloc::vec::Vec;
use blake2b_ref::Blake2bBuilder;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::Entity,
    debug,
    high_level::{load_cell_capacity, load_cell_data, load_cell_lock, load_witness_args},
};

const TAG_GAME: u8 = 0x00;

const STATUS_WAITING: u8 = 0;
const STATUS_COMMIT: u8 = 1;
const STATUS_REVEAL: u8 = 2;
const STATUS_FINISHED: u8 = 3;

const DIR_NONE: u8 = 0xFF;

const MIN_PLAYERS: u8 = 2;
const MAX_PLAYERS: u8 = 6;
const ROUNDS: u8 = 3;
const DIRECTION_COUNT: u8 = 4;

const BLAKE2B_PERSONAL: &[u8; 16] = b"four-gods-reveal";

#[repr(i8)]
#[derive(Debug)]
enum Error {
    Encoding = 1,
    StateTransition = 2,
    PlayerCount = 3,
    NotFound = 4,
    BadCapacity = 5,
    BadSignature = 6,
    BadCommit = 7,
    BadReveal = 8,
    BadDirection = 9,
    PayoutMismatch = 10,
    InvalidOutput = 11,
    Unauthorized = 12,
}

impl From<Error> for i8 {
    fn from(err: Error) -> i8 {
        err as i8
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Player {
    lock_script: Vec<u8>,
    balance: u64,
    bet: u64,
    used_directions: u8,
    commit_hash: [u8; 32],
    revealed_direction: u8,
    survived: bool,
    has_committed: bool,
    has_revealed: bool,
    active_from_round: u8,
}

impl Player {
    fn deserialize(data: &[u8], pos: &mut usize) -> Result<Self, Error> {
        let lock_len = read_u16(data, pos)? as usize;
        let lock_script = read_bytes(data, pos, lock_len)?;
        let balance = read_u64(data, pos)?;
        let bet = read_u64(data, pos)?;
        let used_directions = read_u8(data, pos)?;
        let commit_hash = read_bytes32(data, pos)?;
        let revealed_direction = read_u8(data, pos)?;
        let survived = read_u8(data, pos)? != 0;
        let has_committed = read_u8(data, pos)? != 0;
        let has_revealed = read_u8(data, pos)? != 0;
        let active_from_round = read_u8(data, pos)?;
        Ok(Player {
            lock_script,
            balance,
            bet,
            used_directions,
            commit_hash,
            revealed_direction,
            survived,
            has_committed,
            has_revealed,
            active_from_round,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
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
    fn deserialize(data: &[u8]) -> Result<Self, Error> {
        let mut pos = 0;
        if read_u8(data, &mut pos)? != TAG_GAME {
            return Err(Error::Encoding);
        }
        let status = read_u8(data, &mut pos)?;
        let min_players = read_u8(data, &mut pos)?;
        let max_players = read_u8(data, &mut pos)?;
        let num_players = read_u8(data, &mut pos)?;
        let round = read_u8(data, &mut pos)?;
        let banker_index = read_u8(data, &mut pos)?;
        let reveal_cursor = read_u8(data, &mut pos)?;
        let timeout_blocks = read_u64(data, &mut pos)?;
        let reveal_order_len = read_u8(data, &mut pos)? as usize;
        let mut reveal_order = Vec::with_capacity(reveal_order_len);
        for _ in 0..reveal_order_len {
            reveal_order.push(read_u8(data, &mut pos)?);
        }
        let player_len = read_u8(data, &mut pos)? as usize;
        let mut players = Vec::with_capacity(player_len);
        for _ in 0..player_len {
            players.push(Player::deserialize(data, &mut pos)?);
        }
        Ok(GameState {
            status,
            min_players,
            max_players,
            num_players,
            round,
            banker_index,
            reveal_cursor,
            timeout_blocks,
            reveal_order,
            players,
        })
    }
}

fn read_u8(data: &[u8], pos: &mut usize) -> Result<u8, Error> {
    if *pos >= data.len() {
        return Err(Error::Encoding);
    }
    let v = data[*pos];
    *pos += 1;
    Ok(v)
}

fn read_u16(data: &[u8], pos: &mut usize) -> Result<u16, Error> {
    if *pos + 2 > data.len() {
        return Err(Error::Encoding);
    }
    let v = u16::from_le_bytes([data[*pos], data[*pos + 1]]);
    *pos += 2;
    Ok(v)
}

fn read_u64(data: &[u8], pos: &mut usize) -> Result<u64, Error> {
    if *pos + 8 > data.len() {
        return Err(Error::Encoding);
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[*pos..*pos + 8]);
    let v = u64::from_le_bytes(bytes);
    *pos += 8;
    Ok(v)
}

fn read_bytes(data: &[u8], pos: &mut usize, len: usize) -> Result<Vec<u8>, Error> {
    if *pos + len > data.len() {
        return Err(Error::Encoding);
    }
    let v = data[*pos..*pos + len].to_vec();
    *pos += len;
    Ok(v)
}

fn read_bytes32(data: &[u8], pos: &mut usize) -> Result<[u8; 32], Error> {
    if *pos + 32 > data.len() {
        return Err(Error::Encoding);
    }
    let mut v = [0u8; 32];
    v.copy_from_slice(&data[*pos..*pos + 32]);
    *pos += 32;
    Ok(v)
}

fn input_has_lock(lock: &[u8]) -> bool {
    let mut i = 0;
    loop {
        match load_cell_lock(i, Source::Input) {
            Ok(cell_lock) => {
                if cell_lock.as_slice() == lock {
                    return true;
                }
            }
            Err(_) => break,
        }
        i += 1;
    }
    false
}

fn find_input_index_by_lock(lock: &[u8]) -> Option<usize> {
    let mut i = 0;
    loop {
        match load_cell_lock(i, Source::Input) {
            Ok(cell_lock) => {
                if cell_lock.as_slice() == lock {
                    return Some(i);
                }
            }
            Err(_) => break,
        }
        i += 1;
    }
    None
}

fn hash_reveal(direction: u8, nonce: &[u8]) -> [u8; 32] {
    let mut ctx = Blake2bBuilder::new(32).personal(BLAKE2B_PERSONAL).build();
    ctx.update(&[direction]);
    ctx.update(nonce);
    let mut result = [0u8; 32];
    ctx.finalize(&mut result);
    result
}

fn load_player_nonce(lock: &[u8]) -> Result<Vec<u8>, Error> {
    let idx = find_input_index_by_lock(lock).ok_or(Error::BadSignature)?;
    let witness = load_witness_args(idx, Source::Input).map_err(|_| Error::BadReveal)?;
    let nonce = witness
        .input_type()
        .to_opt()
        .ok_or(Error::BadReveal)?
        .raw_data();
    if nonce.is_empty() {
        return Err(Error::BadReveal);
    }
    Ok(nonce.to_vec())
}

fn require_equal_states(a: &GameState, b: &GameState) -> Result<(), Error> {
    if a != b {
        return Err(Error::StateTransition);
    }
    Ok(())
}

fn load_next_game_data() -> Result<Option<Vec<u8>>, Error> {
    if let Ok(data) = load_cell_data(0, Source::GroupOutput) {
        return Ok(Some(data));
    }

    let group_lock = match load_cell_lock(0, Source::GroupInput) {
        Ok(lock) => lock,
        Err(_) => return Ok(None),
    };

    let mut found = None;
    let mut i = 0;
    loop {
        match load_cell_lock(i, Source::Output) {
            Ok(lock) => {
                if lock.as_slice() == group_lock.as_slice() {
                    if found.is_some() {
                        return Err(Error::InvalidOutput);
                    }
                    let data =
                        load_cell_data(i, Source::Output).map_err(|_| Error::InvalidOutput)?;
                    found = Some(data);
                }
            }
            Err(_) => break,
        }
        i += 1;
    }
    Ok(found)
}

fn load_next_game_capacity() -> Result<Option<u64>, Error> {
    if let Ok(capacity) = load_cell_capacity(0, Source::GroupOutput) {
        return Ok(Some(capacity));
    }

    let group_lock = match load_cell_lock(0, Source::GroupInput) {
        Ok(lock) => lock,
        Err(_) => return Ok(None),
    };

    let mut found = None;
    let mut i = 0;
    loop {
        match load_cell_lock(i, Source::Output) {
            Ok(lock) => {
                if lock.as_slice() == group_lock.as_slice() {
                    if found.is_some() {
                        return Err(Error::InvalidOutput);
                    }
                    let capacity =
                        load_cell_capacity(i, Source::Output).map_err(|_| Error::InvalidOutput)?;
                    found = Some(capacity);
                }
            }
            Err(_) => break,
        }
        i += 1;
    }
    Ok(found)
}

fn validate_create(_input: Option<&[u8]>, output: &[u8]) -> Result<(), Error> {
    let state = GameState::deserialize(output)?;
    if state.status != STATUS_WAITING
        || state.min_players < MIN_PLAYERS
        || state.max_players > MAX_PLAYERS
        || state.min_players > state.max_players
        || state.num_players as usize != state.players.len()
        || state.num_players > 1
        || state.timeout_blocks == 0
    {
        return Err(Error::StateTransition);
    }
    if let Some(host) = state.players.first() {
        if host.bet == 0
            || host.balance != host.bet
            || host.used_directions != 0
            || host.commit_hash != [0u8; 32]
            || host.revealed_direction != DIR_NONE
            || !host.survived
            || host.has_committed
            || host.has_revealed
            || host.active_from_round != 0
            || host.lock_script.is_empty()
            || !input_has_lock(&host.lock_script)
        {
            return Err(Error::StateTransition);
        }
    }
    Ok(())
}

fn validate_join(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let old = GameState::deserialize(input)?;
    let new = GameState::deserialize(output)?;
    if old.status == STATUS_FINISHED || new.status != old.status {
        return Err(Error::StateTransition);
    }
    if new.num_players != old.num_players + 1 || new.players.len() != old.players.len() + 1 {
        return Err(Error::PlayerCount);
    }
    if new.num_players > new.max_players {
        return Err(Error::PlayerCount);
    }
    // unchanged prefix must match old state
    let mut expected = old.clone();
    expected.num_players = new.num_players;
    expected.players = new.players.clone();
    require_equal_states(&expected, &new)?;

    let added = new.players.last().ok_or(Error::PlayerCount)?;
    let active_from_round = if old.status == STATUS_WAITING {
        0
    } else {
        old.round + 1
    };
    if active_from_round >= ROUNDS {
        return Err(Error::PlayerCount);
    }
    if added.bet == 0
        || added.balance != added.bet
        || added.used_directions != 0
        || added.commit_hash != [0u8; 32]
        || added.revealed_direction != DIR_NONE
        || !added.survived
        || added.has_committed
        || added.has_revealed
        || added.active_from_round != active_from_round
    {
        return Err(Error::BadCapacity);
    }
    if added.lock_script.is_empty() || !input_has_lock(&added.lock_script) {
        return Err(Error::BadSignature);
    }
    if old
        .players
        .iter()
        .any(|p| p.lock_script == added.lock_script)
    {
        return Err(Error::PlayerCount);
    }
    let old_cap = load_cell_capacity(0, Source::GroupInput).map_err(|_| Error::NotFound)?;
    let new_cap = load_next_game_capacity()?.ok_or(Error::NotFound)?;
    if new_cap < old_cap + added.bet {
        return Err(Error::BadCapacity);
    }
    Ok(())
}

fn player_is_active(player: &Player, round: u8) -> bool {
    player.survived && player.active_from_round <= round
}

fn compute_reveal_order(players: &[Player], round: u8) -> Vec<u8> {
    let mut order: Vec<u8> = (0..players.len() as u8)
        .filter(|i| player_is_active(&players[*i as usize], round))
        .collect();
    order.sort_by(|a, b| {
        let pa = &players[*a as usize];
        let pb = &players[*b as usize];
        pa.bet.cmp(&pb.bet).then_with(|| a.cmp(b))
    });
    order
}

fn validate_start(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let old = GameState::deserialize(input)?;
    let new = GameState::deserialize(output)?;
    if old.status != STATUS_WAITING || new.status != STATUS_COMMIT {
        return Err(Error::StateTransition);
    }
    if new.num_players < new.min_players || new.num_players > new.max_players {
        return Err(Error::PlayerCount);
    }
    if new.num_players as usize != new.players.len() {
        return Err(Error::PlayerCount);
    }
    // host (first player) must sign
    if new.players.is_empty() || !input_has_lock(&new.players[0].lock_script) {
        return Err(Error::Unauthorized);
    }
    let mut expected = old.clone();
    expected.status = STATUS_COMMIT;
    expected.round = 0;
    expected.banker_index = 0;
    expected.reveal_cursor = 0;
    expected.players = new.players.clone();
    expected.reveal_order = compute_reveal_order(&expected.players, expected.round);
    require_equal_states(&expected, &new)?;

    // banker's balance must cover potential payouts to all other players
    let banker = &new.players[0];
    let total_other_bets: u64 = new.players.iter().skip(1).map(|p| p.bet).sum();
    if banker.balance < total_other_bets {
        return Err(Error::BadCapacity);
    }
    Ok(())
}

fn all_committed(state: &GameState) -> bool {
    state
        .players
        .iter()
        .filter(|p| player_is_active(p, state.round))
        .all(|p| p.has_committed)
}

fn resolve_round(state: &mut GameState) -> Result<(), Error> {
    let banker_idx = state.banker_index as usize;
    if !player_is_active(&state.players[banker_idx], state.round) {
        return Err(Error::StateTransition);
    }
    let banker_dir = state.players[banker_idx].revealed_direction;
    if banker_dir >= DIRECTION_COUNT {
        return Err(Error::BadReveal);
    }
    for i in 0..state.players.len() {
        if i == banker_idx || !player_is_active(&state.players[i], state.round) {
            continue;
        }
        let dir = state.players[i].revealed_direction;
        if dir >= DIRECTION_COUNT {
            return Err(Error::BadReveal);
        }
        if dir == banker_dir {
            let bet = state.players[i].bet;
            state.players[i].balance -= bet;
            state.players[banker_idx].balance += bet;
            state.players[i].survived = false;
        }
    }
    if state.round == ROUNDS - 1 {
        for i in 0..state.players.len() {
            if i == banker_idx {
                continue;
            }
            if state.players[i].survived {
                let bet = state.players[i].bet;
                state.players[i].balance += bet;
                state.players[banker_idx].balance -= bet;
            }
        }
        state.status = STATUS_FINISHED;
    } else {
        let next_round = state.round + 1;
        let newly_active_bets: u64 = state
            .players
            .iter()
            .filter(|p| p.survived && p.active_from_round == next_round)
            .map(|p| p.bet)
            .sum();
        state.players[banker_idx].balance += newly_active_bets;
        state.round += 1;
        state.status = STATUS_COMMIT;
        state.reveal_cursor = 0;
        for p in &mut state.players {
            p.commit_hash = [0u8; 32];
            p.revealed_direction = DIR_NONE;
            p.has_committed = false;
            p.has_revealed = false;
        }
        state.reveal_order = compute_reveal_order(&state.players, state.round);
    }
    Ok(())
}

fn validate_commit(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let old = GameState::deserialize(input)?;
    let new = GameState::deserialize(output)?;
    if old.status != STATUS_COMMIT || new.status != STATUS_COMMIT {
        return Err(Error::StateTransition);
    }
    if old.players.len() != new.players.len() {
        return Err(Error::BadCommit);
    }

    // find exactly one player who moved from uncommitted to committed
    let mut changed: Option<usize> = None;
    for i in 0..old.players.len() {
        let op = &old.players[i];
        let np = &new.players[i];
        if op == np {
            continue;
        }
        if changed.is_some() {
            return Err(Error::BadCommit);
        }
        if np.lock_script != op.lock_script
            || np.balance != op.balance
            || np.bet != op.bet
            || np.used_directions != op.used_directions
            || np.revealed_direction != op.revealed_direction
            || np.survived != op.survived
            || np.active_from_round != op.active_from_round
            || np.has_revealed != op.has_revealed
            || op.has_committed
            || !np.has_committed
            || np.commit_hash == [0u8; 32]
            || !player_is_active(op, old.round)
        {
            return Err(Error::BadCommit);
        }
        if !input_has_lock(&np.lock_script) {
            return Err(Error::BadSignature);
        }
        changed = Some(i);
    }
    if changed.is_none() {
        return Err(Error::BadCommit);
    }

    let mut expected = old.clone();
    expected.players = new.players.clone();
    require_equal_states(&expected, &new)?;
    Ok(())
}

fn all_revealed(state: &GameState) -> bool {
    state
        .players
        .iter()
        .filter(|p| player_is_active(p, state.round))
        .all(|p| p.has_revealed)
}

fn validate_reveal(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let old = GameState::deserialize(input)?;
    let new = GameState::deserialize(output)?;
    if old.status != STATUS_COMMIT && old.status != STATUS_REVEAL {
        return Err(Error::StateTransition);
    }
    // first reveal can move from Commit to Reveal; all subsequent reveals stay in Reveal
    if old.status == STATUS_COMMIT && !all_committed(&old) {
        return Err(Error::BadReveal);
    }
    if old.players.len() != new.players.len() {
        return Err(Error::BadReveal);
    }
    if old.reveal_cursor as usize >= old.reveal_order.len() {
        return Err(Error::BadReveal);
    }
    let expected_idx = old.reveal_order[old.reveal_cursor as usize] as usize;
    if expected_idx >= old.players.len() || !player_is_active(&old.players[expected_idx], old.round)
    {
        return Err(Error::BadReveal);
    }

    let mut changed: Option<usize> = None;
    for i in 0..old.players.len() {
        let op = &old.players[i];
        let np = &new.players[i];
        if op == np {
            continue;
        }
        if changed.is_some() || i != expected_idx {
            return Err(Error::BadReveal);
        }
        if np.lock_script != op.lock_script
            || np.balance != op.balance
            || np.bet != op.bet
            || np.commit_hash != op.commit_hash
            || np.survived != op.survived
            || np.active_from_round != op.active_from_round
            || !op.has_committed
            || op.has_revealed
            || !np.has_revealed
        {
            return Err(Error::BadReveal);
        }
        let dir = np.revealed_direction;
        if dir >= DIRECTION_COUNT {
            return Err(Error::BadDirection);
        }
        if op.used_directions & (1u8 << dir) != 0 {
            return Err(Error::BadDirection);
        }
        let expected_used = op.used_directions | (1u8 << dir);
        if np.used_directions != expected_used {
            return Err(Error::BadDirection);
        }
        let nonce = load_player_nonce(&np.lock_script)?;
        if hash_reveal(dir, &nonce) != op.commit_hash {
            return Err(Error::BadReveal);
        }
        if !input_has_lock(&np.lock_script) {
            return Err(Error::BadSignature);
        }
        changed = Some(i);
    }
    if changed.is_none() {
        return Err(Error::BadReveal);
    }

    let mut expected = old.clone();
    expected.players = new.players.clone();
    expected.status = STATUS_REVEAL;
    expected.reveal_cursor = old.reveal_cursor + 1;
    require_equal_states(&expected, &new)?;
    Ok(())
}

fn validate_resolve(input: &[u8], output: &[u8]) -> Result<(), Error> {
    let old = GameState::deserialize(input)?;
    let new = GameState::deserialize(output)?;
    if old.status != STATUS_REVEAL {
        return Err(Error::StateTransition);
    }
    if !all_revealed(&old) {
        return Err(Error::BadReveal);
    }

    let newly_active_bets: u64 = if old.round < ROUNDS - 1 {
        let next_round = old.round + 1;
        old.players
            .iter()
            .filter(|p| p.survived && p.active_from_round == next_round)
            .map(|p| p.bet)
            .sum()
    } else {
        0
    };
    let mut expected = old.clone();
    resolve_round(&mut expected)?;
    require_equal_states(&expected, &new)?;
    if newly_active_bets > 0 {
        if !input_has_lock(&old.players[old.banker_index as usize].lock_script) {
            return Err(Error::Unauthorized);
        }
        let old_cap = load_cell_capacity(0, Source::GroupInput).map_err(|_| Error::NotFound)?;
        let new_cap = load_next_game_capacity()?.ok_or(Error::NotFound)?;
        if new_cap < old_cap + newly_active_bets {
            return Err(Error::BadCapacity);
        }
    }
    Ok(())
}

fn validate_finish(input: &[u8], _output: &[u8]) -> Result<(), Error> {
    let old = GameState::deserialize(input)?;
    if old.status != STATUS_FINISHED {
        return Err(Error::StateTransition);
    }
    // ensure every player gets at least their balance
    let mut used = Vec::new();
    for p in &old.players {
        let mut found = false;
        let mut i = 0;
        loop {
            match load_cell_lock(i, Source::Output) {
                Ok(lock) => {
                    if lock.as_slice() == p.lock_script.as_slice() {
                        if used.contains(&i) {
                            return Err(Error::InvalidOutput);
                        }
                        let cap = load_cell_capacity(i, Source::Output)
                            .map_err(|_| Error::InvalidOutput)?;
                        if cap >= p.balance {
                            used.push(i);
                            found = true;
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
            i += 1;
        }
        if !found {
            return Err(Error::PayoutMismatch);
        }
    }
    Ok(())
}

pub fn program_entry() -> i8 {
    let input_data = match load_cell_data(0, Source::GroupInput) {
        Ok(d) => Some(d),
        Err(_) => None,
    };
    let output_data = match load_next_game_data() {
        Ok(d) => d,
        Err(e) => return e.into(),
    };

    let result = match (input_data.as_deref(), output_data.as_deref()) {
        (None, Some(out)) => validate_create(None, out),
        (Some(inp), Some(out)) => {
            let old = match GameState::deserialize(inp) {
                Ok(s) => s,
                Err(e) => return e.into(),
            };
            let new = match GameState::deserialize(out) {
                Ok(s) => s,
                Err(e) => return e.into(),
            };
            match (old.status, new.status) {
                (STATUS_WAITING, STATUS_WAITING) => validate_join(inp, out),
                (STATUS_WAITING, STATUS_COMMIT) => validate_start(inp, out),
                (STATUS_COMMIT, STATUS_COMMIT) => {
                    if new.players.len() == old.players.len() + 1 {
                        validate_join(inp, out)
                    } else {
                        validate_commit(inp, out)
                    }
                }
                (STATUS_COMMIT, STATUS_REVEAL) => validate_reveal(inp, out),
                (STATUS_REVEAL, STATUS_REVEAL) => {
                    if new.players.len() == old.players.len() + 1 {
                        validate_join(inp, out)
                    } else {
                        validate_reveal(inp, out)
                    }
                }
                (STATUS_REVEAL, STATUS_COMMIT) | (STATUS_REVEAL, STATUS_FINISHED) => {
                    validate_resolve(inp, out)
                }
                (_, STATUS_FINISHED) => validate_resolve(inp, out),
                _ => Err(Error::StateTransition),
            }
        }
        (Some(inp), None) => validate_finish(inp, &[]),
        (None, None) => Err(Error::StateTransition),
    };

    match result {
        Ok(_) => 0,
        Err(e) => {
            debug!("four-gods error: {:?}", e);
            e.into()
        }
    }
}
