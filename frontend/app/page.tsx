"use client";

import { useCcc, useSigner } from "@ckb-ccc/connector-react";
import { ccc } from "@ckb-ccc/ccc";
import { Buffer } from "buffer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FourGodsScene } from "@/components/FourGodsScene";
import {
  buildCommitTx,
  buildCreateGameTx,
  buildFinishTx,
  buildJoinGameTx,
  buildResolveTx,
  buildRevealTx,
  buildStartGameTx,
  fetchGameState,
  fetchLobbyGames,
  GameCell,
  hasFourGodsConfig,
} from "@/lib/contract";
import { getExplorerUrl } from "@/lib/client";
import {
  activePlayerIndexes,
  GameState,
  isPlayerActive,
  pendingPlayerIndexes,
  PlayerState,
  ROUNDS,
  STATUS_COMMIT,
  STATUS_FINISHED,
  STATUS_REVEAL,
  STATUS_WAITING,
} from "@/lib/serializer";

declare global {
  interface Window {
    render_game_to_text?: () => string;
  }
}

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const UNIT_BET_CKB = 100n;
const DIRECTION_NAMES = ["North", "East", "South", "West"];
const DIRECTION_LABELS = ["北 / North", "东 / East", "南 / South", "西 / West"];

const buttonBase =
  "min-h-10 rounded-md border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45";
const primaryButton =
  buttonBase + " border-[#153f3a] bg-[#153f3a] text-white hover:bg-[#0f312d]";
const secondaryButton =
  buttonBase + " border-[#cfd8d2] bg-white text-[#1e2a28] hover:border-[#81918b]";
const dangerButton =
  buttonBase + " border-[#7b2d26] bg-[#7b2d26] text-white hover:bg-[#62231e]";

function statusName(status: number) {
  switch (status) {
    case STATUS_WAITING:
      return "Lobby";
    case STATUS_COMMIT:
      return "Commit";
    case STATUS_REVEAL:
      return "Reveal";
    case STATUS_FINISHED:
      return "Finished";
    default:
      return "Unknown";
  }
}

function statusText(status: number) {
  switch (status) {
    case STATUS_WAITING:
      return "等人入桌";
    case STATUS_COMMIT:
      return "暗扣方位";
    case STATUS_REVEAL:
      return "公开方位";
    case STATUS_FINISHED:
      return "已结算前";
    default:
      return "未知";
  }
}

function statusClass(status: number) {
  switch (status) {
    case STATUS_WAITING:
      return "border-[#d9a441] bg-[#fff7df] text-[#5e3f00]";
    case STATUS_COMMIT:
      return "border-[#5777a7] bg-[#eef4ff] text-[#233f68]";
    case STATUS_REVEAL:
      return "border-[#7f5ca6] bg-[#f5efff] text-[#4b2a6a]";
    case STATUS_FINISHED:
      return "border-[#71807a] bg-[#edf1ef] text-[#34413d]";
    default:
      return "border-[#cfd8d2] bg-white text-[#1e2a28]";
  }
}

function formatCkb(shannons: bigint): string {
  return (Number(shannons) / 100_000_000).toFixed(2) + " CKB";
}

function shortHex(hex: string, head = 10, tail = 8) {
  if (!hex) return "";
  if (hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}...${hex.slice(-tail)}`;
}

function isSameLock(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function usedDirections(mask: number) {
  const names = DIRECTION_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
  return names.length ? names.join(", ") : "none";
}

function roomCanAcceptPlayer(state: GameState) {
  if (state.status === STATUS_FINISHED) return false;
  if (state.players.length >= state.maxPlayers) return false;
  if (state.status !== STATUS_WAITING && state.round >= ROUNDS - 1) return false;
  return true;
}

function pendingActivationBet(state: GameState) {
  if (state.round >= ROUNDS - 1) return 0n;
  return state.players
    .filter((p) => p.survived && p.activeFromRound === state.round + 1)
    .reduce((sum, p) => sum + p.bet, 0n);
}

function allActiveRevealed(state: GameState) {
  return state.players
    .filter((p) => isPlayerActive(p, state.round))
    .every((p) => p.hasRevealed);
}

function promptForGame(walletConnected: boolean, game: GameCell | null, myIndex: number, readyToStart: boolean) {
  if (!walletConnected) return "连接钱包后进入大厅，开自适应挑战房，或直接加入链上已有房间。";
  if (!game) return "大厅会显示当前 Four Gods 房间。开房后你会自动坐下，第二位玩家加入后即可开局。";

  const state = game.state;
  const active = activePlayerIndexes(state).length;
  const pending = pendingPlayerIndexes(state).length;
  if (state.status === STATUS_WAITING) {
    if (readyToStart) return myIndex === 0 ? "已有 2 位以上玩家，房主可以开局。" : "等待房主开局。";
    return `房间已坐下 ${active} 人，还差 ${Math.max(0, MIN_PLAYERS - active)} 人即可开局。`;
  }
  if (myIndex >= 0 && !isPlayerActive(state.players[myIndex], state.round)) {
    return `你已加入，将从 Round ${state.players[myIndex].activeFromRound + 1} 入桌。`;
  }
  if (state.status === STATUS_COMMIT) {
    if (myIndex === -1) return pending ? `${pending} 人在等下一轮入桌。` : "本轮正在暗扣方位。";
    if (state.players[myIndex].hasCommitted) return "你已暗扣方位，等待其他本轮玩家。";
    return "轮到你暗扣本轮方位。";
  }
  if (state.status === STATUS_REVEAL) {
    if (allActiveRevealed(state)) return "本轮已全部公开，可以 resolve 进入下一轮。";
    const next = state.revealOrder[state.revealCursor];
    return next === myIndex ? "轮到你公开方位。" : `等待 Player ${next} 公开方位。`;
  }
  return "游戏结束，可以结算。";
}

export default function Home() {
  const { client, open, disconnect, wallet } = useCcc();
  const signer = useSigner();
  const [gameId, setGameId] = useState("");
  const [manualGameId, setManualGameId] = useState("");
  const [game, setGame] = useState<GameCell | null>(null);
  const [lobby, setLobby] = useState<GameCell[]>([]);
  const [myLock, setMyLock] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lobbyLoading, setLobbyLoading] = useState(false);
  const [selectedDirection, setSelectedDirection] = useState(0);
  const commitsRef = useRef<Record<string, { direction: number; nonce: Uint8Array }>>({});

  const addLog = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLogs((prev) => [...prev, `[${stamp}] ${msg}`].slice(-80));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!signer) {
      setMyLock("");
      return;
    }
    signer.getRecommendedAddressObj().then((addr) => {
      if (!cancelled) setMyLock("0x" + Buffer.from(addr.script.toBytes()).toString("hex"));
    });
    return () => {
      cancelled = true;
    };
  }, [signer]);

  const refreshGame = useCallback(
    async (id = gameId) => {
      const cleanId = id.trim();
      if (!cleanId) return null;
      const found = await fetchGameState(client, cleanId);
      setGame(found);
      if (found) {
        setGameId(found.gameId);
        setManualGameId(found.gameId);
      } else {
        addLog("game not indexed yet; wait a moment and refresh");
      }
      return found;
    },
    [client, gameId, addLog]
  );

  const refreshLobby = useCallback(async () => {
    setLobbyLoading(true);
    try {
      const rooms = await fetchLobbyGames(client, 80);
      setLobby(rooms);
      if (gameId) {
        const current = rooms.find((room) => room.gameId === gameId);
        if (current) setGame(current);
      }
    } catch (e) {
      addLog(`lobby refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLobbyLoading(false);
    }
  }, [client, gameId, addLog]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get("game");
    if (idFromUrl) {
      setGameId(idFromUrl);
      setManualGameId(idFromUrl);
      refreshGame(idFromUrl);
    }
    refreshLobby();
    const interval = window.setInterval(refreshLobby, 20_000);
    return () => window.clearInterval(interval);
  }, [refreshGame, refreshLobby]);

  const send = useCallback(
    async (label: string, builder: () => Promise<ccc.Transaction>) => {
      if (!signer) {
        addLog(`${label} failed: wallet not connected`);
        return null;
      }
      setBusy(true);
      try {
        const tx = await builder();
        const signed = await signer.signTransaction(tx);
        const txHash = await client.sendTransaction(signed);
        addLog(`${label} tx: ${txHash}`);
        addLog(`explorer: ${getExplorerUrl(txHash)}`);
        return txHash;
      } catch (e: unknown) {
        addLog(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [signer, client, addLog]
  );

  const myIndex = game ? game.state.players.findIndex((p) => isSameLock(p.lockScript, myLock)) : -1;
  const isHost = myIndex === 0;
  const activeIndexes = useMemo(() => (game ? activePlayerIndexes(game.state) : []), [game]);
  const pendingIndexes = useMemo(() => (game ? pendingPlayerIndexes(game.state) : []), [game]);
  const readyToStart = Boolean(game && game.state.status === STATUS_WAITING && activeIndexes.length >= MIN_PLAYERS);
  const canJoin = Boolean(game && myIndex === -1 && roomCanAcceptPlayer(game.state));
  const joinWillBePending = Boolean(game && game.state.status !== STATUS_WAITING);
  const nextRevealIndex = game?.state.revealOrder[game.state.revealCursor] ?? -1;
  const isMyRevealTurn = Boolean(
    game &&
      game.state.status === STATUS_REVEAL &&
      myIndex >= 0 &&
      isPlayerActive(game.state.players[myIndex], game.state.round) &&
      nextRevealIndex === myIndex &&
      !game.state.players[myIndex].hasRevealed
  );
  const resolveNeedsBanker = Boolean(game && pendingActivationBet(game.state) > 0n);
  const canResolve = Boolean(
    game &&
      game.state.status === STATUS_REVEAL &&
      allActiveRevealed(game.state) &&
      (!resolveNeedsBanker || isHost)
  );
  const prompt = promptForGame(Boolean(wallet), game, myIndex, readyToStart);
  const openRooms = lobby.filter((room) => roomCanAcceptPlayer(room.state));
  const activeRooms = lobby.filter((room) => room.state.status !== STATUS_FINISHED);
  const contractReady = hasFourGodsConfig();

  const seats = useMemo(() => {
    const seatCount = game?.state.maxPlayers ?? MAX_PLAYERS;
    return Array.from({ length: seatCount }, (_, index) => ({
      index,
      player: game?.state.players[index],
    }));
  }, [game]);

  useEffect(() => {
    const snapshot = {
      mode: game ? "room" : "lobby",
      wallet: wallet?.name ?? null,
      lobbyRooms: lobby.length,
      openRooms: openRooms.length,
      gameId,
      status: game ? statusName(game.state.status) : "No game",
      round: game ? game.state.round + 1 : null,
      activePlayers: game ? activeIndexes : [],
      pendingPlayers: game ? pendingIndexes : [],
      myIndex,
      prompt,
      players:
        game?.state.players.map((p, index) => ({
          index,
          you: isSameLock(p.lockScript, myLock),
          banker: index === game.state.bankerIndex,
          active: isPlayerActive(p, game.state.round),
          activeFromRound: p.activeFromRound,
          balance: formatCkb(p.balance),
          bet: formatCkb(p.bet),
          committed: p.hasCommitted,
          revealed: p.hasRevealed ? DIRECTION_NAMES[p.revealedDirection] ?? "unknown" : false,
        })) ?? [],
    };
    window.render_game_to_text = () => JSON.stringify(snapshot, null, 2);
    return () => {
      delete window.render_game_to_text;
    };
  }, [wallet, lobby.length, openRooms.length, gameId, game, activeIndexes, pendingIndexes, myIndex, prompt, myLock]);

  const createRoom = async () => {
    let createdId = "";
    const txHash = await send("open room", async () => {
      const { tx, gameId: id } = await buildCreateGameTx(signer!, {
        minPlayers: MIN_PLAYERS,
        maxPlayers: MAX_PLAYERS,
        timeoutBlocks: 100n,
        unitBetCkb: UNIT_BET_CKB,
      });
      createdId = id;
      setGameId(id);
      setManualGameId(id);
      return tx;
    });
    if (txHash && createdId) {
      await refreshGame(createdId);
      await refreshLobby();
    }
  };

  const joinRoom = async (room: GameCell) => {
    setGame(room);
    setGameId(room.gameId);
    setManualGameId(room.gameId);
    const txHash = await send(room.state.status === STATUS_WAITING ? "join" : "join next round", () =>
      buildJoinGameTx(signer!, room.gameId, room, UNIT_BET_CKB)
    );
    if (txHash) {
      await refreshGame(room.gameId);
      await refreshLobby();
    }
  };

  return (
    <main className="min-h-screen bg-[#f4f6f3] text-[#1e2a28]">
      <section className="relative min-h-[46vh] overflow-hidden border-b border-[#d8dfdb]">
        <FourGodsScene
          game={game}
          myLock={myLock}
          previewSeats={MAX_PLAYERS}
          lobbyCount={lobby.length}
          openRoomCount={openRooms.length}
        />
        <div className="relative z-10 mx-auto flex min-h-[46vh] w-full max-w-6xl flex-col justify-between px-4 py-5 sm:px-6 lg:px-8">
          <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-normal text-[#14201e] sm:text-4xl">
                四神围 / Four Gods
              </h1>
              <p className="mt-1 text-sm font-medium text-[#5d6a66]">
                CKB testnet · adaptive 2-6 players · 100 CKB seat
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {wallet ? (
                <>
                  <div className="rounded-md border border-[#cfd8d2] bg-white/90 px-3 py-2 text-sm shadow-sm">
                    <span className="text-[#66746f]">Wallet</span>{" "}
                    <span className="font-semibold text-[#1e2a28]">{wallet.name}</span>
                  </div>
                  <button className={secondaryButton + " bg-white/90"} onClick={disconnect} disabled={busy}>
                    Disconnect
                  </button>
                </>
              ) : (
                <button className={primaryButton} onClick={open} disabled={busy}>
                  Connect Wallet
                </button>
              )}
            </div>
          </header>

          <div className="mt-12 max-w-xl rounded-md border border-[#d8dfdb] bg-white/88 p-4 shadow-sm backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              {game ? (
                <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${statusClass(game.state.status)}`}>
                  {statusName(game.state.status)} · {statusText(game.state.status)}
                </span>
              ) : (
                <span className="rounded-md border border-[#cfd8d2] bg-white px-2.5 py-1 text-xs font-semibold text-[#66746f]">
                  Lobby
                </span>
              )}
              <span className="rounded-md bg-[#edf1ef] px-2.5 py-1 text-xs font-semibold text-[#42504c]">
                {openRooms.length} open / {activeRooms.length} active
              </span>
            </div>
            <div className="mt-3 text-lg font-semibold leading-snug text-[#14201e]">{prompt}</div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8">
        <div className="space-y-4">
          <div className="rounded-md border border-[#d8dfdb] bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#66746f]">Challenge Hall</h2>
                <p className="mt-1 text-sm text-[#5d6a66]">链上房间自动扫描；等待中和可中途加入的房间会排在前面。</p>
              </div>
              <div className="flex gap-2">
                <button className={secondaryButton} onClick={refreshLobby} disabled={lobbyLoading || busy}>
                  {lobbyLoading ? "Refreshing" : "Refresh"}
                </button>
                <button className={primaryButton} onClick={createRoom} disabled={!signer || busy || !contractReady}>
                  Open room
                </button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {lobby.length ? (
                lobby.map((room) => (
                  <RoomCard
                    key={room.gameId}
                    room={room}
                    selected={room.gameId === gameId}
                    myLock={myLock}
                    onEnter={() => {
                      setGame(room);
                      setGameId(room.gameId);
                      setManualGameId(room.gameId);
                    }}
                    onJoin={() => joinRoom(room)}
                    canJoin={Boolean(signer && !busy && roomCanAcceptPlayer(room.state))}
                  />
                ))
              ) : (
                <div className="rounded-md border border-dashed border-[#cfd8d2] bg-[#fbfcfb] p-5 text-sm text-[#66746f] md:col-span-2">
                  暂时没有可显示的房间。连接钱包后可以直接开一个自适应挑战房。
                </div>
              )}
            </div>
          </div>

          {game && (
            <div className="rounded-md border border-[#d8dfdb] bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#66746f]">Current Table</h2>
                  <div className="mt-1 font-mono text-xs text-[#66746f]">{shortHex(game.gameId, 18, 14)}</div>
                </div>
                <div className="grid grid-cols-4 gap-2 text-center text-xs">
                  <Stat label="Round" value={`${game.state.round + 1}/${ROUNDS}`} />
                  <Stat label="Active" value={`${activeIndexes.length}`} />
                  <Stat label="Pending" value={`${pendingIndexes.length}`} />
                  <Stat label="Seats" value={`${game.state.players.length}/${game.state.maxPlayers}`} />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {seats.map(({ index, player }) => (
                  <SeatCard
                    key={index}
                    index={index}
                    player={player}
                    round={game.state.round}
                    isYou={Boolean(player && isSameLock(player.lockScript, myLock))}
                    isBanker={index === game.state.bankerIndex}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-md border border-[#d8dfdb] bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#66746f]">Actions</h2>
              {busy && <span className="rounded-md bg-[#edf1ef] px-2 py-1 text-xs text-[#42504c]">Signing...</span>}
            </div>

            <div className="space-y-3">
              {!signer && (
                <button className={primaryButton + " w-full"} onClick={open} disabled={busy}>
                  Connect Wallet
                </button>
              )}

              {signer && !game && (
                <button className={primaryButton + " w-full"} onClick={createRoom} disabled={busy || !contractReady}>
                  Open adaptive room
                </button>
              )}

              {signer && !contractReady && (
                <div className="rounded-md border border-[#d8dfdb] bg-[#fbfcfb] p-3 text-sm text-[#5d6a66]">
                  Contract env vars are missing. Deploy the latest contract and set Vercel env first.
                </div>
              )}

              {signer && game && canJoin && (
                <button className={primaryButton + " w-full"} onClick={() => joinRoom(game)} disabled={busy}>
                  {joinWillBePending ? "Join next round" : "Join room"}
                </button>
              )}

              {signer && game?.state.status === STATUS_WAITING && isHost && (
                <button
                  className={primaryButton + " w-full"}
                  onClick={async () => {
                    const txHash = await send("start", () => buildStartGameTx(signer, game.gameId, game));
                    if (txHash) {
                      await refreshGame(game.gameId);
                      await refreshLobby();
                    }
                  }}
                  disabled={busy || !readyToStart}
                >
                  {readyToStart ? "Start round 1" : "Need one more player"}
                </button>
              )}

              {signer &&
                game?.state.status === STATUS_COMMIT &&
                myIndex >= 0 &&
                isPlayerActive(game.state.players[myIndex], game.state.round) &&
                !game.state.players[myIndex].hasCommitted && (
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-[#66746f]">
                      Direction
                    </label>
                    <select
                      className="min-h-10 w-full rounded-md border border-[#cfd8d2] bg-white px-3 py-2 text-sm outline-none focus:border-[#153f3a]"
                      value={selectedDirection}
                      onChange={(e) => setSelectedDirection(Number(e.target.value))}
                    >
                      {DIRECTION_LABELS.map((name, i) => (
                        <option key={i} value={i}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button
                      className={primaryButton + " w-full"}
                      onClick={async () => {
                        const nonce = crypto.getRandomValues(new Uint8Array(32));
                        const txHash = await send("commit", async () => {
                          const { tx } = await buildCommitTx(
                            signer,
                            game.gameId,
                            game,
                            selectedDirection,
                            nonce
                          );
                          commitsRef.current[`${game.gameId}-${myIndex}-${game.state.round}`] = {
                            direction: selectedDirection,
                            nonce,
                          };
                          return tx;
                        });
                        if (txHash) await refreshGame(game.gameId);
                      }}
                      disabled={busy}
                    >
                      Commit hidden direction
                    </button>
                  </div>
                )}

              {signer && game && isMyRevealTurn && (
                <button
                  className={primaryButton + " w-full"}
                  onClick={async () => {
                    const key = `${game.gameId}-${myIndex}-${game.state.round}`;
                    const commit = commitsRef.current[key];
                    if (!commit) {
                      addLog("commit secret not found; use the same browser session that committed");
                      return;
                    }
                    const txHash = await send("reveal", () =>
                      buildRevealTx(signer, game.gameId, game, commit.direction, commit.nonce)
                    );
                    if (txHash) await refreshGame(game.gameId);
                  }}
                  disabled={busy}
                >
                  Reveal direction
                </button>
              )}

              {signer && game?.state.status === STATUS_REVEAL && allActiveRevealed(game.state) && (
                <button
                  className={secondaryButton + " w-full"}
                  onClick={async () => {
                    const txHash = await send("resolve", () => buildResolveTx(signer, game.gameId, game));
                    if (txHash) {
                      await refreshGame(game.gameId);
                      await refreshLobby();
                    }
                  }}
                  disabled={busy || !canResolve}
                >
                  {resolveNeedsBanker && !isHost ? "Waiting for banker to resolve" : "Resolve round"}
                </button>
              )}

              {signer && game?.state.status === STATUS_FINISHED && (
                <button
                  className={dangerButton + " w-full"}
                  onClick={async () => {
                    const txHash = await send("finish", () => buildFinishTx(signer, game.gameId, game));
                    if (txHash) {
                      setGame(null);
                      setGameId("");
                      await refreshLobby();
                    }
                  }}
                  disabled={busy}
                >
                  Finish / settle
                </button>
              )}

              {game && myIndex >= 0 && !isPlayerActive(game.state.players[myIndex], game.state.round) && (
                <div className="rounded-md border border-[#d8dfdb] bg-[#fbfcfb] p-3 text-sm text-[#5d6a66]">
                  已加入等待区，下一轮自动入桌。
                </div>
              )}
            </div>
          </div>

          <div className="rounded-md border border-[#d8dfdb] bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-[#66746f]">Direct Load</h2>
            <div className="flex gap-2">
              <input
                className="min-h-10 min-w-0 flex-1 rounded-md border border-[#cfd8d2] bg-[#fbfcfb] px-3 py-2 font-mono text-sm outline-none focus:border-[#153f3a]"
                placeholder="0x..."
                value={manualGameId}
                onChange={(e) => setManualGameId(e.target.value)}
              />
              <button
                className={secondaryButton}
                onClick={() => {
                  setGameId(manualGameId.trim());
                  refreshGame(manualGameId.trim());
                }}
                disabled={busy || !manualGameId.trim()}
              >
                Load
              </button>
            </div>
          </div>

          <div className="rounded-md border border-[#d8dfdb] bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#66746f]">Transaction Log</h2>
              <button className="text-xs text-[#66746f] hover:text-[#153f3a]" onClick={() => setLogs([])}>
                Clear
              </button>
            </div>
            <div className="h-56 overflow-auto rounded-md border border-[#d8dfdb] bg-[#0f1715] p-3 font-mono text-xs text-[#d8e5df]">
              {logs.length ? (
                logs.map((line, i) => (
                  <div key={i} className="break-words py-0.5">
                    {line}
                  </div>
                ))
              ) : (
                <div className="text-[#7f918a]">No transactions yet.</div>
              )}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[64px] rounded-md border border-[#d8dfdb] bg-[#fbfcfb] p-2">
      <div className="text-[#66746f]">{label}</div>
      <div className="mt-1 font-semibold text-[#14201e]">{value}</div>
    </div>
  );
}

function RoomCard({
  room,
  selected,
  myLock,
  canJoin,
  onEnter,
  onJoin,
}: {
  room: GameCell;
  selected: boolean;
  myLock: string;
  canJoin: boolean;
  onEnter: () => void;
  onJoin: () => void;
}) {
  const active = activePlayerIndexes(room.state).length;
  const pending = pendingPlayerIndexes(room.state).length;
  const alreadyIn = room.state.players.some((p) => isSameLock(p.lockScript, myLock));
  const joinable = canJoin && !alreadyIn;

  return (
    <div
      className={`rounded-md border p-3 ${
        selected ? "border-[#153f3a] bg-[#f4fbf7]" : "border-[#d8dfdb] bg-[#fbfcfb]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-xs text-[#66746f]">{shortHex(room.gameId, 14, 10)}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusClass(room.state.status)}`}>
              {statusName(room.state.status)}
            </span>
            {alreadyIn && <span className="rounded-md bg-[#153f3a] px-2 py-1 text-xs font-semibold text-white">You</span>}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold text-[#14201e]">{active} active</div>
          <div className="text-xs text-[#66746f]">{pending} pending · {room.state.players.length}/{room.state.maxPlayers}</div>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button className={secondaryButton + " flex-1"} onClick={onEnter}>
          Enter
        </button>
        <button className={primaryButton + " flex-1"} onClick={onJoin} disabled={!joinable}>
          {room.state.status === STATUS_WAITING ? "Join" : "Join next"}
        </button>
      </div>
    </div>
  );
}

function SeatCard({
  index,
  player,
  round,
  isYou,
  isBanker,
}: {
  index: number;
  player?: PlayerState;
  round: number;
  isYou: boolean;
  isBanker: boolean;
}) {
  if (!player) {
    return (
      <div className="min-h-[156px] rounded-md border border-dashed border-[#c5cec9] bg-[#fbfcfb] p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-[#42504c]">Player {index}</div>
          <span className="rounded-md bg-[#edf1ef] px-2 py-1 text-xs text-[#66746f]">Open</span>
        </div>
        <div className="mt-7 text-sm text-[#66746f]">等待新挑战者</div>
      </div>
    );
  }

  const active = isPlayerActive(player, round);
  return (
    <div className="min-h-[156px] rounded-md border border-[#cfd8d2] bg-[#fbfcfb] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-[#14201e]">Player {index}</div>
        <div className="flex flex-wrap gap-1">
          {isYou && <span className="rounded-md bg-[#153f3a] px-2 py-1 text-xs font-semibold text-white">You</span>}
          {isBanker && <span className="rounded-md bg-[#fff0c2] px-2 py-1 text-xs font-semibold text-[#6c4a00]">Banker</span>}
          <span className={`rounded-md px-2 py-1 text-xs font-semibold ${active ? "bg-[#e7f4ec] text-[#25563b]" : "bg-[#edf1ef] text-[#66746f]"}`}>
            {active ? "Active" : `Round ${player.activeFromRound + 1}`}
          </span>
        </div>
      </div>

      <div className="mt-3 break-all font-mono text-xs text-[#66746f]">{shortHex(player.lockScript, 14, 12)}</div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-md border border-[#d8dfdb] bg-white p-2">
          <div className="text-xs text-[#66746f]">Balance</div>
          <div className="mt-1 font-semibold">{formatCkb(player.balance)}</div>
        </div>
        <div className="rounded-md border border-[#d8dfdb] bg-white p-2">
          <div className="text-xs text-[#66746f]">Bet</div>
          <div className="mt-1 font-semibold">{formatCkb(player.bet)}</div>
        </div>
      </div>
      <div className="mt-3 grid gap-1 text-xs text-[#5d6a66]">
        <div>Committed: {player.hasCommitted ? "yes" : "no"}</div>
        <div>Revealed: {player.hasRevealed ? DIRECTION_NAMES[player.revealedDirection] ?? "unknown" : "no"}</div>
        <div>Used: {usedDirections(player.usedDirections)}</div>
      </div>
    </div>
  );
}
