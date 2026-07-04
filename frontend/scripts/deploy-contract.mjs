#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ccc } from "@ckb-ccc/shell";

const SHANNONS = 100_000_000n;
const ZERO_CODE_HASH = `0x${"00".repeat(32)}`;
const scriptDir = dirname(fileURLToPath(import.meta.url));

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function normalizePrivateKey(value) {
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("CKB_PRIVATE_KEY must be a 32-byte hex string");
  }
  return key;
}

function ckb(value) {
  const whole = value / SHANNONS;
  const frac = (value % SHANNONS).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} CKB`;
}

function printEnv({ network, rpcUrl, txHash, codeHash }) {
  console.log("");
  console.log("Vercel env:");
  console.log(`NEXT_PUBLIC_CKB_NETWORK=${network}`);
  console.log(`NEXT_PUBLIC_CKB_RPC_URL=${rpcUrl}`);
  console.log(`NEXT_PUBLIC_FOUR_GODS_CODE_HASH=${codeHash}`);
  console.log("NEXT_PUBLIC_FOUR_GODS_HASH_TYPE=data1");
  console.log(`NEXT_PUBLIC_FOUR_GODS_TX_HASH=${txHash ?? "<deploy_tx_hash>"}`);
  console.log("NEXT_PUBLIC_FOUR_GODS_TX_INDEX=0");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const network = env("CKB_NETWORK", env("NEXT_PUBLIC_CKB_NETWORK", "testnet"));
  if (!["testnet", "mainnet"].includes(network)) {
    throw new Error("CKB_NETWORK must be testnet or mainnet");
  }

  const binaryPath = resolve(
    process.cwd(),
    env("CONTRACT_BINARY", resolve(scriptDir, "../../contracts/build/release/four-gods")),
  );
  const binary = readFileSync(binaryPath);
  const binaryHex = ccc.hexFrom(binary);
  const codeHash = ccc.hashCkb(binary);
  const rpcUrl = env("CKB_RPC_URL");
  const clientConfig = rpcUrl ? { url: rpcUrl } : undefined;
  const client =
    network === "mainnet"
      ? new ccc.ClientPublicMainnet(clientConfig)
      : new ccc.ClientPublicTestnet(clientConfig);

  const lockMode = env("CKB_DEPLOY_LOCK", network === "mainnet" ? "owner" : "zero");
  if (!["zero", "owner"].includes(lockMode)) {
    throw new Error("CKB_DEPLOY_LOCK must be zero or owner");
  }

  const privateKey = env("CKB_PRIVATE_KEY");
  const signer = privateKey
    ? new ccc.SignerCkbPrivateKey(client, normalizePrivateKey(privateKey))
    : undefined;

  const ownerLock = signer ? (await signer.getRecommendedAddressObj()).script : undefined;
  const deployLock =
    lockMode === "zero"
      ? ccc.Script.from({ codeHash: ZERO_CODE_HASH, hashType: "data1", args: "0x" })
      : ownerLock;

  if (!deployLock) {
    throw new Error("CKB_PRIVATE_KEY is required when CKB_DEPLOY_LOCK=owner");
  }

  const tx = ccc.Transaction.default();
  tx.addOutput({ lock: deployLock }, binaryHex);

  console.log(`Network: ${network}`);
  console.log(`Contract: ${binaryPath}`);
  console.log(`Binary bytes: ${binary.length}`);
  console.log(`Code hash: ${codeHash}`);
  console.log(`Deploy lock: ${lockMode}`);
  console.log(`Output capacity: ${ckb(tx.outputs[0].capacity)}`);

  if (dryRun) {
    printEnv({ network, rpcUrl, codeHash });
    console.log("");
    console.log("Dry run only. Set CKB_PRIVATE_KEY and run without --dry-run to broadcast.");
    return;
  }

  if (!signer) {
    throw new Error("CKB_PRIVATE_KEY is required to deploy");
  }

  const feeRate = BigInt(env("CKB_FEE_RATE", "1000"));
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, feeRate);
  const txHash = await signer.sendTransaction(tx);

  console.log(`Deploy tx: ${txHash}`);
  printEnv({ network, rpcUrl, txHash, codeHash });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
