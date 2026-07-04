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
  isPlayerActive,
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

export type GameCell = { gameId: string; cell: ccc.Cell; state: GameState };

export function hasFourGodsConfig(): boolean {
  return Boolean(
    FOUR_GODS_CODE_HASH &&
      FOUR_GODS_TX_HASH &&
      !FOUR_GODS_TX_HASH.startsWith("<") &&
      Number.isFinite(FOUR_GODS_TX_INDEX)
  );
}

function assertFourGodsConfig() {
  if (!hasFourGodsConfig()) {
    throw new Error("Four Gods contract env vars are not configured");
  }
}

export function getFourGodsLockScript(gameId: string): ccc.Script {
  if (!FOUR_GODS_CODE_HASH) {
    throw new Error("NEXT_PUBLIC_FOUR_GODS_CODE_HASH is not configured");
  }
  return ccc.Script.from({
    codeHash: FOUR_GODS_CODE_HASH,
    hashType: FOUR_GODS_HASH_TYPE,
    args: gameId,
  });
}

export function getScriptCellDep(): ccc.CellDep {
  assertFourGodsConfig();
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
): Promise<GameCell | null> {
  const lockScript = getFourGodsLockScript(gameId);
  for await (const cell of client.findCells({
    script: lockScript,
    scriptType: "lock",
    scriptSearchMode: "exact",
    withData: true,
  })) {
    const state = deserializeGame(hexToBytes(cell.outputData));
    return { gameId, cell, state };
  }
  return null;
}

export async function fetchLobbyGames(client: ccc.Client, limit = 80): Promise<GameCell[]> {
  if (!FOUR_GODS_CODE_HASH) return [];
  const rooms: GameCell[] = [];
  const prefixLock = getFourGodsLockScript("0x");
  const searchKey = {
    script: prefixLock,
    scriptType: "lock" as const,
    scriptSearchMode: "prefix" as const,
    withData: true,
  };
  let cursor: string | undefined;

  while (rooms.length < limit) {
    const { cells, lastCursor } = await client.findCellsPagedNoCache(
      searchKey,
      "desc",
      Math.min(50, limit - rooms.length),
      cursor
    );
    for (const cell of cells) {
      try {
        const state = deserializeGame(hexToBytes(cell.outputData));
        rooms.push({
          gameId: cell.cellOutput.lock.args,
          cell,
          state,
        });
      } catch {
        // Ignore old-format or unrelated cells if the indexer returns a broader prefix match.
      }
    }
    if (cells.length === 0 || cells.length < Math.min(50, limit - rooms.length)) break;
    cursor = lastCursor;
  }

  return rooms.sort((a, b) => {
    const waitingDelta =
      Number(b.state.status === STATUS_WAITING) - Number(a.state.status === STATUS_WAITING);
    if (waitingDelta !== 0) return waitingDelta;
    return b.state.players.length - a.state.players.length;
  });
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
  const unitBet = unitBetToCapacity(config.unitBetCkb);
  const lockScript = (await signer.getRecommendedAddressObj()).script;
  const lockHex = bytesToHex(lockScript.toBytes());
  const state: GameState = {
    ...emptyGameState(config.minPlayers, config.maxPlayers, config.timeoutBlocks),
    numPlayers: 1,
    players: [
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
        activeFromRound: 0,
      },
    ],
  };

  const tx = ccc.Transaction.from({
    outputs: [gameOutput(gameId, state, GAME_OVERHEAD + unitBet)],
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

  if (current.state.status === STATUS_FINISHED) {
    throw new Error("game is finished");
  }
  if (current.state.players.length >= current.state.maxPlayers) {
    throw new Error("game is full");
  }
  if (current.state.players.some((p) => p.lockScript === lockHex)) {
    throw new Error("already joined");
  }
  const activeFromRound =
    current.state.status === STATUS_WAITING ? 0 : current.state.round + 1;
  if (activeFromRound >= 3) {
    throw new Error("too late to join this game");
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
        activeFromRound,
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
      activeFromRound: 0,
      balance: i === 0 ? unitBet * BigInt(n) : p.balance,
    })),
    revealOrder: computeRevealOrder(state.players, 0),
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
  if (!isPlayerActive(state.players[idx], state.round)) {
    throw new Error("you enter on the next round");
  }
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
  if (state.players.some((p) => isPlayerActive(p, state.round) && !p.hasCommitted)) {
    throw new Error("not all committed");
  }

  const lockScript = (await signer.getRecommendedAddressObj()).script;
  const lockHex = bytesToHex(lockScript.toBytes());
  const idx = state.players.findIndex((p) => p.lockScript === lockHex);
  if (idx === -1) throw new Error("not a player");
  if (!isPlayerActive(state.players[idx], state.round)) {
    throw new Error("you enter on the next round");
  }
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
    if (!isPlayerActive(state.players[i], state.round)) continue;
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
      if (isPlayerActive(state.players[i], state.round)) {
        const bet = state.players[i].bet;
        state.players[i].balance += bet;
        state.players[bankerIdx].balance -= bet;
      }
    }
    state.status = STATUS_FINISHED;
  } else {
    const nextRound = state.round + 1;
    const newlyActiveBet = state.players
      .filter((p) => p.survived && p.activeFromRound === nextRound)
      .reduce((sum, p) => sum + p.bet, 0n);
    state.players[bankerIdx].balance += newlyActiveBet;
    state.round += 1;
    state.status = STATUS_COMMIT;
    state.revealCursor = 0;
    for (const p of state.players) {
      p.commitHash = "0x" + "00".repeat(32);
      p.revealedDirection = DIR_NONE;
      p.hasCommitted = false;
      p.hasRevealed = false;
    }
    state.revealOrder = computeRevealOrder(state.players, state.round);
  }
}

export async function buildResolveTx(
  signer: ccc.Signer,
  gameId: string,
  current: { cell: ccc.Cell; state: GameState }
) {
  const state = current.state;
  if (state.status !== STATUS_REVEAL) throw new Error("not reveal phase");
  if (state.players.some((p) => isPlayerActive(p, state.round) && !p.hasRevealed)) {
    throw new Error("not all revealed");
  }

  const newState: GameState = {
    ...state,
    players: state.players.map((p) => ({ ...p })),
  };
  const newlyActiveBet =
    state.round < 2
      ? state.players
          .filter((p) => p.survived && p.activeFromRound === state.round + 1)
          .reduce((sum, p) => sum + p.bet, 0n)
      : 0n;
  resolveRound(newState);

  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: current.cell.outPoint,
        cellOutput: current.cell.cellOutput,
        outputData: current.cell.outputData,
      },
    ],
    outputs: [gameOutput(gameId, newState, BigInt(current.cell.cellOutput.capacity) + newlyActiveBet)],
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
