import { ccc } from "@ckb-ccc/ccc";
import {
  bytesToHex,
  computeRevealOrder,
  deserializeGame,
  DIRECTIONS,
  DIR_NONE,
  emptyGameState,
  GameState,
  hashReveal,
  hexToBytes,
  serializeGame,
  STATUS_COMMIT,
  STATUS_FINISHED,
  STATUS_REVEAL,
  STATUS_WAITING,
} from "./serializer";

const FOUR_GODS_CODE_HASH = process.env.NEXT_PUBLIC_FOUR_GODS_CODE_HASH!;
const FOUR_GODS_HASH_TYPE = (process.env.NEXT_PUBLIC_FOUR_GODS_HASH_TYPE ?? "data") as ccc.HashType;
const FOUR_GODS_TX_HASH = process.env.NEXT_PUBLIC_FOUR_GODS_TX_HASH!;
const FOUR_GODS_TX_INDEX = Number(process.env.NEXT_PUBLIC_FOUR_GODS_TX_INDEX ?? 0);

export function getFourGodsLockScript(gameId: string): ccc.Script {
  return ccc.Script.from({
    codeHash: FOUR_GODS_CODE_HASH,
    hashType: FOUR_GODS_HASH_TYPE,
    args: gameId,
  });
}

export function getScriptCellDep(): ccc.CellDep {
  return ccc.CellDep.from({
    outPoint: {
      txHash: FOUR_GODS_TX_HASH,
      index: FOUR_GODS_TX_INDEX,
    },
    depType: "code",
  });
}

export function generateGameId(creatorAddress: string, timestamp: number): string {
  const hasher = new ccc.HasherCkb();
  hasher.update(Buffer.from(creatorAddress.replace("0x", ""), "hex"));
  hasher.update(Buffer.from(timestamp.toString()));
  return hasher.digest();
}

export async function fetchGameState(
  client: ccc.Client,
  gameId: string
): Promise<{ cell: ccc.Cell; state: GameState } | null> {
  const lockScript = getFourGodsLockScript(gameId);
  for await (const cell of client.findCells({
    script: lockScript,
    scriptType: "lock",
    scriptSearchMode: "exact",
    withData: true,
  })) {
    const state = deserializeGame(hexToBytes(cell.outputData));
    return { cell, state };
  }
  return null;
}

function gameOutput(
  gameId: string,
  state: GameState,
  capacity: bigint
): ccc.CellOutputLike {
  return {
    capacity,
    lock: getFourGodsLockScript(gameId),
  };
}

function stateData(state: GameState): string {
  return bytesToHex(serializeGame(state));
}

const CKB = 100_000_000n;
const GAME_OVERHEAD_CKB = 1000n;
const GAME_OVERHEAD = GAME_OVERHEAD_CKB * CKB;

export function unitBetToCapacity(unitBetCkb: bigint): bigint {
  return unitBetCkb * CKB;
}

export async function buildCreateGameTx(
  signer: ccc.Signer,
  config: { minPlayers: number; maxPlayers: number; timeoutBlocks: bigint; unitBetCkb: bigint }
) {
  const address = await signer.getRecommendedAddress();
  const gameId = generateGameId(address, Date.now());
  const state = emptyGameState(config.minPlayers, config.maxPlayers, config.timeoutBlocks);

  const tx = ccc.Transaction.from({
    outputs: [gameOutput(gameId, state, GAME_OVERHEAD)],
    outputsData: [stateData(state)],
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return { tx, gameId };
}

export async function buildJoinGameTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState },
  unitBetCkb: bigint
) {
  const unitBet = unitBetCkb * CKB;
  const lockScript = (await signer.getRecommendedAddressObj()).script;
  const lockHex = bytesToHex(lockScript.toBytes());

  if (current.state.status !== STATUS_WAITING) {
    throw new Error("game is not waiting for players");
  }
  if (current.state.players.length >= current.state.maxPlayers) {
    throw new Error("game is full");
  }
  if (current.state.players.some((p) => p.lockScript === lockHex)) {
    throw new Error("already joined");
  }

  const newState: GameState = {
    ...current.state,
    numPlayers: current.state.numPlayers + 1,
    players: [
      ...current.state.players,
      {
        lockScript: lockHex,
        balance: unitBet,
        bet: unitBet,
        usedDirections: 0,
        commitHash: "0x" + "00".repeat(32),
        revealedDirection: DIR_NONE,
        survived: true,
        hasCommitted: false,
        hasRevealed: false,
      },
    ],
  };

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs: [gameOutput(gameId, newState, BigInt(current.cell.cellOutput.capacity) + unitBet)],
    outputsData: [stateData(newState)],
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return tx;
}

export async function buildStartGameTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState }
) {
  const state = current.state;
  if (state.status !== STATUS_WAITING) throw new Error("not waiting");
  if (state.players.length < state.minPlayers) throw new Error("not enough players");

  const unitBet = state.players[0].bet;
  const n = state.players.length;
  const extra = unitBet * BigInt(n - 1);

  const newState: GameState = {
    ...state,
    status: STATUS_COMMIT,
    round: 0,
    bankerIndex: 0,
    revealCursor: 0,
    players: state.players.map((p, i) => ({
      ...p,
      balance: i === 0 ? unitBet * BigInt(n) : p.balance,
    })),
    revealOrder: computeRevealOrder(state.players),
  };

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs: [gameOutput(gameId, newState, BigInt(current.cell.cellOutput.capacity) + extra)],
    outputsData: [stateData(newState)],
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return tx;
}

export async function buildCommitTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState },
  direction: number,
  nonce: Uint8Array
) {
  const state = current.state;
  if (state.status !== STATUS_COMMIT) throw new Error("not commit phase");

  const lockScript = (await signer.getRecommendedAddressObj()).script;
  const lockHex = bytesToHex(lockScript.toBytes());
  const idx = state.players.findIndex((p) => p.lockScript === lockHex);
  if (idx === -1) throw new Error("not a player");
  if (state.players[idx].hasCommitted) throw new Error("already committed");
  if (direction < 0 || direction >= DIRECTIONS) throw new Error("bad direction");

  const commitHash = hashReveal(direction, nonce);
  const newState: GameState = {
    ...state,
    players: state.players.map((p, i) =>
      i === idx ? { ...p, commitHash, hasCommitted: true } : p
    ),
  };

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs: [gameOutput(gameId, newState, BigInt(current.cell.cellOutput.capacity))],
    outputsData: [stateData(newState)],
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return { tx, commitHash };
}

export async function buildRevealTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState },
  direction: number,
  nonce: Uint8Array
) {
  const state = current.state;
  if (state.status !== STATUS_COMMIT && state.status !== STATUS_REVEAL) {
    throw new Error("not reveal phase");
  }
  if (state.players.some((p) => !p.hasCommitted)) {
    throw new Error("not all committed");
  }

  const lockScript = (await signer.getRecommendedAddressObj()).script;
  const lockHex = bytesToHex(lockScript.toBytes());
  const idx = state.players.findIndex((p) => p.lockScript === lockHex);
  if (idx === -1) throw new Error("not a player");
  if (state.players[idx].hasRevealed) throw new Error("already revealed");

  const expectedIdx = state.revealOrder[state.revealCursor];
  if (idx !== expectedIdx) throw new Error("not your turn to reveal");

  const player = state.players[idx];
  if (hashReveal(direction, nonce) !== player.commitHash) {
    throw new Error("commit hash mismatch");
  }
  if (player.usedDirections & (1 << direction)) {
    throw new Error("direction already used");
  }

  const newState: GameState = {
    ...state,
    status: STATUS_REVEAL,
    revealCursor: state.revealCursor + 1,
    players: state.players.map((p, i) =>
      i === idx
        ? {
            ...p,
            revealedDirection: direction,
            usedDirections: p.usedDirections | (1 << direction),
            hasRevealed: true,
          }
        : p
    ),
  };

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs: [gameOutput(gameId, newState, BigInt(current.cell.cellOutput.capacity))],
    outputsData: [stateData(newState)],
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);

  // attach nonce to the witness of the player's input
  const playerInputIdx = tx.inputs.findIndex(
    (input) => input.cellOutput && bytesToHex(input.cellOutput.lock.toBytes()) === lockHex
  );
  if (playerInputIdx >= 0) {
    const witness = ccc.WitnessArgs.from({
      lock: "0x",
      inputType: bytesToHex(nonce),
      outputType: "0x",
    });
    tx.witnesses[playerInputIdx] = witness.toHex();
  }

  return tx;
}

function resolveRound(state: GameState) {
  const bankerIdx = state.bankerIndex;
  const bankerDir = state.players[bankerIdx].revealedDirection;
  if (bankerDir >= DIRECTIONS) throw new Error("banker not revealed");

  for (let i = 0; i < state.players.length; i++) {
    if (i === bankerIdx) continue;
    const dir = state.players[i].revealedDirection;
    if (dir >= DIRECTIONS) throw new Error("player not revealed");
    if (dir === bankerDir) {
      const bet = state.players[i].bet;
      state.players[i].balance -= bet;
      state.players[bankerIdx].balance += bet;
      state.players[i].survived = false;
    }
  }

  if (state.round === 2) {
    for (let i = 0; i < state.players.length; i++) {
      if (i === bankerIdx) continue;
      if (state.players[i].survived) {
        const bet = state.players[i].bet;
        state.players[i].balance += bet;
        state.players[bankerIdx].balance -= bet;
      }
    }
    state.status = STATUS_FINISHED;
  } else {
    state.round += 1;
    state.status = STATUS_COMMIT;
    state.revealCursor = 0;
    for (const p of state.players) {
      p.commitHash = "0x" + "00".repeat(32);
      p.revealedDirection = DIR_NONE;
      p.hasCommitted = false;
      p.hasRevealed = false;
    }
  }
}

export async function buildResolveTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState }
) {
  const state = current.state;
  if (state.status !== STATUS_REVEAL) throw new Error("not reveal phase");
  if (state.players.some((p) => !p.hasRevealed)) throw new Error("not all revealed");

  const newState: GameState = {
    ...state,
    players: state.players.map((p) => ({ ...p })),
  };
  resolveRound(newState);

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs: [gameOutput(gameId, newState, BigInt(current.cell.cellOutput.capacity))],
    outputsData: [stateData(newState)],
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return tx;
}

export async function buildFinishTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState }
) {
  const state = current.state;
  if (state.status !== STATUS_FINISHED) throw new Error("not finished");

  const outputs: ccc.CellOutputLike[] = [];
  const outputsData: string[] = [];
  let remaining = BigInt(current.cell.cellOutput.capacity);

  for (const p of state.players) {
    const cap = p.balance + GAME_OVERHEAD / BigInt(state.players.length + 1);
    outputs.push({
      capacity: cap,
      lock: ccc.Script.fromBytes(hexToBytes(p.lockScript)),
    });
    outputsData.push("0x");
    remaining -= cap;
  }

  if (remaining > 0n) {
    outputs.push({
      capacity: remaining,
      lock: ccc.Script.fromBytes(hexToBytes(state.players[0].lockScript)),
    });
    outputsData.push("0x");
  }

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs,
    outputsData,
    cellDeps: [getScriptCellDep()],
    witnesses: ["0x"],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return tx;
}
