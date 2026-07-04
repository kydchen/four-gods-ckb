import { ccc } from "@ckb-ccc/ccc";

export const NETWORK = process.env.NEXT_PUBLIC_CKB_NETWORK ?? "testnet";

export function getClient(): ccc.Client {
  const rpcUrl = process.env.NEXT_PUBLIC_CKB_RPC_URL;
  const config = rpcUrl ? { url: rpcUrl } : undefined;
  if (NETWORK === "mainnet") {
    return new ccc.ClientPublicMainnet(config);
  }
  return new ccc.ClientPublicTestnet(config);
}

export function getExplorerUrl(txHash: string): string {
  const base =
    NETWORK === "mainnet"
      ? "https://explorer.nervos.org/transaction/"
      : "https://testnet.explorer.nervos.org/transaction/";
  return base + txHash;
}
