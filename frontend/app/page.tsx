"use client";

import { useCcc, useSigner } from "@ckb-ccc/connector-react";
import { ccc } from "@ckb-ccc/ccc";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildCommitTx,
  buildCreateGameTx,
  buildFinishTx,
  buildJoinGameTx,
  buildResolveTx,
  buildRevealTx,
  buildStartGameTx,
  fetchGameState,
} from "@/lib/contract";
import {
  GameState,
  STATUS_COMMIT,
  STATUS_FINISHED,
  STATUS_REVEAL,
  STATUS_WAITING,
} from "@/lib/serializer";
import { getExplorerUrl } from "@/lib/client";

const DIRECTION_NAMES = ["North", "East", "South", "West"];

function statusName(status: number) {
  switch (status) {
    case STATUS_WAITING:
      return "Waiting";
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

function formatCkb(shannons: bigint): string {
  return (Number(shannons) / 100_000_000).toFixed(4) + " CKB";
}

export default function Home() {
  const { client, open, disconnect, wallet } = useCcc();
  const signer = useSigner();
  const [gameId, setGameId] = useState("");
  const [game, setGame] = useState<{ cell: ccc.Cell; state: GameState } | null>(null);
  const [myLock, setMyLock] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const commitsRef = useRef<Record<string, { direction: number; nonce: Uint8Array }>>({});

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    if (!signer) {
      setMyLock("");
      return;
    }
    signer.getRecommendedAddressObj().then((addr) => {
      setMyLock("0x" + Buffer.from(addr.script.toBytes()).toString("hex"));
    });
  }, [signer]);

  const refresh = useCallback(async () => {
    if (!gameId) return;
    const found = await fetchGameState(client, gameId);
    setGame(found);
    if (!found) addLog("game not found");
  }, [client, gameId, addLog]);

  const send = useCallback(
    async (label: string, builder: () => Promise<ccc.Transaction>) => {
      if (!signer) return;
      setBusy(true);
      try {
        const tx = await builder();
        const signed = await signer.signTransaction(tx);
        const txHash = await client.sendTransaction(signed);
        addLog(`${label} tx: ${txHash}`);
        addLog(`explorer: ${getExplorerUrl(txHash)}`);
      } catch (e: unknown) {
        addLog(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [signer, client, addLog]
  );

  const myIndex = game ? game.state.players.findIndex((p) => p.lockScript === myLock) : -1;
  const isHost = myIndex === 0;

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">四神围 / Four Gods</h1>

      <div className="flex items-center gap-4">
        {wallet ? (
          <>
            <span className="text-sm">{wallet.name}</span>
            <button className="px-3 py-1 border rounded" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="px-3 py-1 border rounded" onClick={open} disabled={busy}>
            Connect Wallet
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1"
          placeholder="game id"
          value={gameId}
          onChange={(e) => setGameId(e.target.value)}
        />
        <button className="px-3 py-1 border rounded" onClick={refresh} disabled={busy || !gameId}>
          Fetch
        </button>
      </div>

      {game && (
        <div className="border rounded p-4 space-y-2">
          <div className="font-semibold">Game State</div>
          <div>Status: {statusName(game.state.status)}</div>
          <div>Round: {game.state.round + 1} / 3</div>
          <div>Banker: player {game.state.bankerIndex}</div>
          <div>Reveal cursor: {game.state.revealCursor}</div>
          <div>Reveal order: {game.state.revealOrder.join(", ")}</div>
          <ul className="divide-y">
            {game.state.players.map((p, i) => (
              <li key={i} className="py-2 text-sm">
                <div>
                  Player {i} {p.lockScript === myLock ? "(you)" : ""} {i === game!.state.bankerIndex ? "(banker)" : ""}
                </div>
                <div>
                  balance {formatCkb(p.balance)} / bet {formatCkb(p.bet)} / committed{" "}
                  {p.hasCommitted ? "yes" : "no"} / revealed{" "}
                  {p.hasRevealed ? DIRECTION_NAMES[p.revealedDirection] ?? "?" : "no"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {signer && (
        <div className="space-y-4 border rounded p-4">
          <h2 className="font-semibold">Actions</h2>

          {!game && (
            <button
              className="px-3 py-1 border rounded block"
              onClick={async () => {
                await send("create", async () => {
                  const { tx, gameId: id } = await buildCreateGameTx(signer!, {
                    minPlayers: 2,
                    maxPlayers: 2,
                    timeoutBlocks: 100n,
                    unitBetCkb: 100n,
                  });
                  setGameId(id);
                  return tx;
                });
                await refresh();
              }}
              disabled={busy}
            >
              Create 2-player game (100 CKB bet)
            </button>
          )}

          {game?.state.status === STATUS_WAITING && myIndex === -1 && (
            <button
              className="px-3 py-1 border rounded"
              onClick={async () => {
                await send("join", () => buildJoinGameTx(signer!, gameId, game!, 100n));
                await refresh();
              }}
              disabled={busy}
            >
              Join game
            </button>
          )}

          {game?.state.status === STATUS_WAITING && isHost && (
            <button
              className="px-3 py-1 border rounded"
              onClick={async () => {
                await send("start", () => buildStartGameTx(signer!, gameId, game!));
                await refresh();
              }}
              disabled={busy}
            >
              Start game
            </button>
          )}

          {game?.state.status === STATUS_COMMIT && myIndex >= 0 && !game.state.players[myIndex].hasCommitted && (
            <div className="flex gap-2">
              <select id="dir" className="border rounded px-2">
                {DIRECTION_NAMES.map((name, i) => (
                  <option key={i} value={i}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                className="px-3 py-1 border rounded"
                onClick={async () => {
                  const dir = Number((document.getElementById("dir") as HTMLSelectElement).value);
                  const nonce = crypto.getRandomValues(new Uint8Array(32));
                  await send("commit", async () => {
                    const { tx } = await buildCommitTx(signer!, gameId, game!, dir, nonce);
                    const key = `${gameId}-${myIndex}-${game!.state.round}`;
                    commitsRef.current[key] = { direction: dir, nonce };
                    return tx;
                  });
                  await refresh();
                }}
                disabled={busy}
              >
                Commit
              </button>
            </div>
          )}

          {game?.state.status === STATUS_REVEAL &&
            myIndex >= 0 &&
            game.state.players[myIndex].hasCommitted &&
            !game.state.players[myIndex].hasRevealed &&
            game.state.revealOrder[game.state.revealCursor] === myIndex && (
              <button
                className="px-3 py-1 border rounded"
                onClick={async () => {
                  const key = `${gameId}-${myIndex}-${game!.state.round}`;
                  const commit = commitsRef.current[key];
                  if (!commit) {
                    addLog("commit secret not found; re-fetch and commit again");
                    return;
                  }
                  await send("reveal", () => buildRevealTx(signer!, gameId, game!, commit.direction, commit.nonce));
                  await refresh();
                }}
                disabled={busy}
              >
                Reveal
              </button>
            )}

          {game?.state.status === STATUS_REVEAL && game.state.players.every((p) => p.hasRevealed) && (
            <button
              className="px-3 py-1 border rounded"
              onClick={async () => {
                await send("resolve", () => buildResolveTx(signer!, gameId, game!));
                await refresh();
              }}
              disabled={busy}
            >
              Resolve round
            </button>
          )}

          {game?.state.status === STATUS_FINISHED && (
            <button
              className="px-3 py-1 border rounded"
              onClick={async () => {
                await send("finish", () => buildFinishTx(signer!, gameId, game!));
                await refresh();
              }}
              disabled={busy}
            >
              Finish / settle
            </button>
          )}
        </div>
      )}

      <div className="border rounded p-4 h-64 overflow-auto text-sm font-mono">
        {logs.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </main>
  );
}
