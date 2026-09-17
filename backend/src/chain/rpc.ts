import { rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../config/env.js";

export const server = new rpc.Server(env.SOROBAN_RPC_URL);

export async function relaySignedXdr(
  signedXdr: string
): Promise<{ hash: string; status: "SUCCESS"; returnValue: unknown }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, env.NETWORK_PASSPHRASE);
  const sendResult = await server.sendTransaction(tx as any);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction rejected: ${JSON.stringify(sendResult.errorResult)}`);
  }
  const hash = sendResult.hash;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const got = await server.getTransaction(hash);
    if (got.status === "SUCCESS") {
      const returnValue = got.returnValue ? scValToNative(got.returnValue) : null;
      return { hash, status: "SUCCESS", returnValue };
    }
    if (got.status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${hash}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for transaction confirmation: ${hash}`);
}
