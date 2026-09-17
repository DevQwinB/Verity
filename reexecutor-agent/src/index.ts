import "dotenv/config";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as EscrowGateClient } from "escrow-gate";
import { runDeterministicFunction } from "./sandbox/runner.js";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.ESCROW_GATE_CONTRACT_ID!;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const ONCE = process.argv.includes("--once");

const keypair = Keypair.fromSecret(process.env.REEXECUTOR_SECRET_KEY!);
const publicKey = keypair.publicKey();
const signer = basicNodeSigner(keypair, NETWORK_PASSPHRASE);

const client = new EscrowGateClient({
  contractId: CONTRACT_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey,
  ...signer,
});

async function login(): Promise<string> {
  const challengeRes = await fetch(`${BACKEND_URL}/auth?account=${publicKey}`);
  const { transaction } = (await challengeRes.json()) as { transaction: string };
  const tx = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
  tx.sign(keypair);
  const verifyRes = await fetch(`${BACKEND_URL}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  const { token } = (await verifyRes.json()) as { token: string };
  if (!token) throw new Error("SEP-10 login failed");
  return token;
}

async function myReexecutorId(): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/v1/reexecutors`);
  const rows = (await res.json()) as Array<{ id: string; stellar_account: string }>;
  const mine = rows.find((r) => r.stellar_account === publicKey);
  if (!mine) throw new Error(`No reexecutor row found for ${publicKey} — register via POST /v1/reexecutors first`);
  return mine.id;
}

async function fetchArtifact(contentHash: string, token: string): Promise<Buffer> {
  const res = await fetch(`${BACKEND_URL}/v1/artifacts/${contentHash}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { content_base64 } = (await res.json()) as { content_base64: string };
  return Buffer.from(content_base64, "base64");
}

async function processReplayAssignment(
  assignment: {
    submission_id: string;
    reexecutor_id: string;
    claimed_output_hash: string;
    function_ref: string | null;
    input_ref: string | null;
    chain_submission_id: string;
  },
  token: string
) {
  console.log(`[reexecutor ${publicKey.slice(0, 8)}] replaying submission ${assignment.chain_submission_id}`);
  const functionHash = assignment.function_ref ? path_basename(assignment.function_ref) : null;
  const inputHash = assignment.input_ref ? path_basename(assignment.input_ref) : null;
  if (!functionHash || !inputHash) {
    console.warn("  missing function/input artifact refs, skipping");
    return;
  }
  const functionSource = (await fetchArtifact(functionHash, token)).toString("utf8");
  const input = JSON.parse((await fetchArtifact(inputHash, token)).toString("utf8"));

  const { outputHash, engine } = runDeterministicFunction(functionSource, input);
  const matched = outputHash === assignment.claimed_output_hash;
  console.log(`  engine=${engine} outputHash=${outputHash} claimed=${assignment.claimed_output_hash} matched=${matched}`);

  const tx = await client.attest_replay({
    reexecutor: publicKey,
    submission_id: BigInt(assignment.chain_submission_id),
    output_hash: Buffer.from(outputHash, "hex"),
    matched,
  });
  const sent = await tx.signAndSend();
  console.log(`  attest_replay tx: ${sent.sendTransactionResponse?.hash ?? "(see result)"}`);
}

function path_basename(ref: string): string {
  const parts = ref.split(/[\\/]/);
  return parts[parts.length - 1];
}

async function pollOnce(reexecutorId: string, token: string) {
  const res = await fetch(`${BACKEND_URL}/v1/reexecutors/${reexecutorId}/assignments`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { replay_assignments } = (await res.json()) as { replay_assignments: any[] };
  for (const assignment of replay_assignments) {
    try {
      await processReplayAssignment(assignment, token);
    } catch (err) {
      console.error("  assignment failed:", err);
    }
  }
}

async function main() {
  console.log(`[reexecutor-agent] starting as ${publicKey}`);
  const token = await login();
  const reexecutorId = await myReexecutorId();
  console.log(`[reexecutor-agent] logged in, reexecutor_id=${reexecutorId}`);

  if (ONCE) {
    await pollOnce(reexecutorId, token);
    return;
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce(reexecutorId, token);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
