import blake2b from "blake2b";

export interface PlayerState {
  lockScript: string; // hex bytes of the full lock script
  balance: bigint;
  bet: bigint;
  usedDirections: number;
  commitHash: string; // hex 32 bytes
  revealedDirection: number;
  survived: boolean;
  hasCommitted: boolean;
  hasRevealed: boolean;
}

export interface GameState {
  status: number;
  minPlayers: number;
  maxPlayers: number;
  numPlayers: number;
  round: number;
  bankerIndex: number;
  revealCursor: number;
  timeoutBlocks: bigint;
  revealOrder: number[];
  players: PlayerState[];
}

const TAG_GAME = 0x00;

export const STATUS_WAITING = 0;
export const STATUS_COMMIT = 1;
export const STATUS_REVEAL = 2;
export const STATUS_FINISHED = 3;

export const DIR_NONE = 0xff;
export const DIRECTIONS = 4;
export const ROUNDS = 3;

function readU8(data: Uint8Array, pos: { i: number }): number {
  return data[pos.i++];
}

function readU16(data: Uint8Array, pos: { i: number }): number {
  const v = new DataView(data.buffer, data.byteOffset + pos.i, 2).getUint16(0, true);
  pos.i += 2;
  return v;
}

function readU64(data: Uint8Array, pos: { i: number }): bigint {
  const v = new DataView(data.buffer, data.byteOffset + pos.i, 8).getBigUint64(0, true);
  pos.i += 8;
  return v;
}

function readBytes(data: Uint8Array, pos: { i: number }, len: number): Uint8Array {
  const slice = data.slice(pos.i, pos.i + len);
  pos.i += len;
  return slice;
}

function writeU8(buf: number[], v: number) {
  buf.push(v & 0xff);
}

function writeU16(buf: number[], v: number) {
  const arr = new Uint8Array(2);
  new DataView(arr.buffer).setUint16(0, v, true);
  buf.push(...arr);
}

function writeU64(buf: number[], v: bigint) {
  const arr = new Uint8Array(8);
  new DataView(arr.buffer).setBigUint64(0, v, true);
  buf.push(...arr);
}

function writeBytes(buf: number[], bytes: Uint8Array) {
  buf.push(...bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

export function serializePlayer(p: PlayerState): Uint8Array {
  const lock = hexToBytes(p.lockScript);
  const buf: number[] = [];
  writeU16(buf, lock.length);
  writeBytes(buf, lock);
  writeU64(buf, p.balance);
  writeU64(buf, p.bet);
  writeU8(buf, p.usedDirections);
  writeBytes(buf, hexToBytes(p.commitHash));
  writeU8(buf, p.revealedDirection);
  writeU8(buf, p.survived ? 1 : 0);
  writeU8(buf, p.hasCommitted ? 1 : 0);
  writeU8(buf, p.hasRevealed ? 1 : 0);
  return Uint8Array.from(buf);
}

export function deserializePlayer(data: Uint8Array, pos: { i: number }): PlayerState {
  const lockLen = readU16(data, pos);
  const lockScript = bytesToHex(readBytes(data, pos, lockLen));
  const balance = readU64(data, pos);
  const bet = readU64(data, pos);
  const usedDirections = readU8(data, pos);
  const commitHash = bytesToHex(readBytes(data, pos, 32));
  const revealedDirection = readU8(data, pos);
  const survived = readU8(data, pos) !== 0;
  const hasCommitted = readU8(data, pos) !== 0;
  const hasRevealed = readU8(data, pos) !== 0;
  return {
    lockScript,
    balance,
    bet,
    usedDirections,
    commitHash,
    revealedDirection,
    survived,
    hasCommitted,
    hasRevealed,
  };
}

export function serializeGame(state: GameState): Uint8Array {
  const buf: number[] = [];
  writeU8(buf, TAG_GAME);
  writeU8(buf, state.status);
  writeU8(buf, state.minPlayers);
  writeU8(buf, state.maxPlayers);
  writeU8(buf, state.numPlayers);
  writeU8(buf, state.round);
  writeU8(buf, state.bankerIndex);
  writeU8(buf, state.revealCursor);
  writeU64(buf, state.timeoutBlocks);
  writeU8(buf, state.revealOrder.length);
  for (const i of state.revealOrder) writeU8(buf, i);
  writeU8(buf, state.players.length);
  for (const p of state.players) {
    writeBytes(buf, serializePlayer(p));
  }
  return Uint8Array.from(buf);
}

export function deserializeGame(data: Uint8Array): GameState {
  const pos = { i: 0 };
  const tag = readU8(data, pos);
  if (tag !== TAG_GAME) throw new Error("invalid game tag");
  const status = readU8(data, pos);
  const minPlayers = readU8(data, pos);
  const maxPlayers = readU8(data, pos);
  const numPlayers = readU8(data, pos);
  const round = readU8(data, pos);
  const bankerIndex = readU8(data, pos);
  const revealCursor = readU8(data, pos);
  const timeoutBlocks = readU64(data, pos);
  const revealOrderLen = readU8(data, pos);
  const revealOrder: number[] = [];
  for (let i = 0; i < revealOrderLen; i++) revealOrder.push(readU8(data, pos));
  const playerLen = readU8(data, pos);
  const players: PlayerState[] = [];
  for (let i = 0; i < playerLen; i++) players.push(deserializePlayer(data, pos));
  return {
    status,
    minPlayers,
    maxPlayers,
    numPlayers,
    round,
    bankerIndex,
    revealCursor,
    timeoutBlocks,
    revealOrder,
    players,
  };
}

export function emptyGameState(minPlayers: number, maxPlayers: number, timeoutBlocks: bigint): GameState {
  return {
    status: STATUS_WAITING,
    minPlayers,
    maxPlayers,
    numPlayers: 0,
    round: 0,
    bankerIndex: 0,
    revealCursor: 0,
    timeoutBlocks,
    revealOrder: [],
    players: [],
  };
}

export function hashReveal(direction: number, nonce: Uint8Array): string {
  const hasher = blake2b(32, undefined, undefined, Buffer.from("four-gods-reveal"));
  hasher.update(Buffer.from([direction]));
  hasher.update(Buffer.from(nonce));
  return "0x" + hasher.digest("hex");
}

export function computeRevealOrder(players: PlayerState[]): number[] {
  const order = players.map((_, i) => i);
  order.sort((a, b) => {
    const cmp = Number(players[a].bet - players[b].bet);
    if (cmp !== 0) return cmp;
    return a - b;
  });
  return order;
}
