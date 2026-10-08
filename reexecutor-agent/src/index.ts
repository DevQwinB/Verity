import "dotenv/config";
import "./net.js";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as EscrowGateClient } from "escrow-gate";
import { runDeterministicFunction } from "./sandbox/runner.js";
import { runRetrieval } from "./sandbox/retrieval.js";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = requireEnv("ESCROW_GATE_CONTRACT_ID");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const ONCE = process.argv.includes("--once");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[reexecutor-agent] ${name} is required (see reexecutor-agent/.env.example)`);
    process.exit(1);
  }
  return value;
}

const keypair = Keypair.fromSecret(requireEnv("REEXECUTOR_SECRET_KEY"));
const publicKey = keypair.publicKey();
const tag = `[reexecutor ${publicKey.slice(0, 8)}]`;

const client = new EscrowGateClient({
  contractId: CONTRACT_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey,
  ...basicNodeSigner(keypair, NETWORK_PASSPHRASE),
});

let token: string | null = null;

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
  const body = (await verifyRes.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(`SEP-10 login failed: ${body.error ?? verifyRes.status}`);
  return body.token;
}

/** The backend's JWT lives for an hour and this process lives for weeks, so
 * every call transparently re-authenticates once on a 401. */
async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    token ??= await login();
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      token = null;
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${data.error ?? "request failed"}`);
    return data;
  }
}

async function fetchArtifact(ref: string): Promise<Buffer> {
  const contentHash = ref.split(/[\\/]/).pop()!;
  const { content_base64 } = await api<{ content_base64: string }>(`/v1/artifacts/${contentHash}`);
  return Buffer.from(content_base64, "base64");
}

interface Assignment {
  task_type: "deterministic" | "retrieval" | "unverifiable";
  claimed_output_hash: string;
  function_ref: string | null;
  input_ref: string | null;
  chain_submission_id: string;
}

/** 32 zero bytes: the recorded output hash when the declared work could not
 * be reproduced at all (it threw, timed out, or its artifacts are missing or
 * malformed). That is itself a mismatch with whatever the agent claimed. */
const NO_OUTPUT_HASH = "0".repeat(64);

/** Re-derives the output from the submission's own declared artifacts. Any
 * failure that is the *submission's* fault resolves to a mismatch — an agent
 * must not be able to dodge a slash by submitting work that crashes the
 * replay. Failures of this agent's own plumbing (backend unreachable) throw
 * instead, and the assignment is simply retried on the next poll. */
async function reExecute(a: Assignment): Promise<{ outputHash: string; engine: string }> {
  if (!a.input_ref) return { outputHash: NO_OUTPUT_HASH, engine: "none (no input artifact declared)" };
  const inputBytes = await fetchArtifact(a.input_ref);

  if (a.task_type === "retrieval") {
    try {
      return await runRetrieval(JSON.parse(inputBytes.toString("utf8")));
    } catch (err) {
      return { outputHash: NO_OUTPUT_HASH, engine: `retrieval failed: ${(err as Error).message}` };
    }
  }

  if (!a.function_ref) return { outputHash: NO_OUTPUT_HASH, engine: "none (no function artifact declared)" };
  const functionSource = (await fetchArtifact(a.function_ref)).toString("utf8");
  try {
    return runDeterministicFunction(functionSource, JSON.parse(inputBytes.toString("utf8")));
  } catch (err) {
    return { outputHash: NO_OUTPUT_HASH, engine: `replay failed: ${(err as Error).message}` };
  }
}

/** Submissions this process has already voted on. The backend keeps listing
 * an assignment until its indexer sees our ReplayAttested event a few
 * seconds later; without this we would re-run and re-send in the meantime. */
const attested = new Set<string>();

async function processAssignment(a: Assignment) {
  if (attested.has(a.chain_submission_id)) return;
  console.log(`${tag} re-executing ${a.task_type} submission #${a.chain_submission_id}`);
  const { outputHash, engine } = await reExecute(a);
  const matched = outputHash === a.claimed_output_hash;
  console.log(`${tag}   engine=${engine}`);
  console.log(`${tag}   output=${outputHash} claimed=${a.claimed_output_hash} matched=${matched}`);

  try {
    const tx = await client.attest_replay({
      reexecutor: publicKey,
      submission_id: BigInt(a.chain_submission_id),
      output_hash: Buffer.from(outputHash, "hex"),
      matched,
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    console.log(`${tag}   attest_replay tx: ${sent.sendTransactionResponse?.hash ?? "(confirmed)"}`);
  } catch (err) {
    const message = (err as Error).message ?? "";
    // #23 AlreadyAttested: our vote is already on-chain. #32 ChallengeWindowClosed:
    // the submission was finalized before we got to it. Either way there is
    // nothing left for us to do for this submission.
    if (!/Error\(Contract, #(23|32)\)/.test(message)) throw err;
    console.log(`${tag}   nothing to do (already attested or already finalized)`);
  }
  attested.add(a.chain_submission_id);
}

async function pollOnce(reexecutorId: string) {
  const { replay_assignments, spot_check_assignments } = await api<{
    replay_assignments: Assignment[];
    spot_check_assignments: Assignment[];
  }>(`/v1/reexecutors/${reexecutorId}/assignments`);
  // A sampled spot-check and a full replay are the same job for the worker:
  // re-derive the output, then put a bonded vote on-chain.
  for (const assignment of [...replay_assignments, ...spot_check_assignments]) {
    try {
      await processAssignment(assignment);
    } catch (err) {
      console.error(`${tag}   assignment #${assignment.chain_submission_id} failed, will retry:`, (err as Error).message);
    }
  }
}

async function main() {
  console.log(`[reexecutor-agent] starting as ${publicKey}`);
  // Mirrors this account's real on-chain stake into the backend, so an
  // account staked by script (or long ago) is assignable without re-staking.
  const { reexecutor } = await api<{ reexecutor: { id: string; active: boolean; stake_amount: string } }>(
    "/v1/reexecutors/sync",
    { method: "POST" }
  );
  console.log(
    `[reexecutor-agent] reexecutor_id=${reexecutor.id} stake=${reexecutor.stake_amount} stroops active=${reexecutor.active}`
  );
  if (!reexecutor.active) {
    console.warn("[reexecutor-agent] stake is below the on-chain floor — no work will be assigned until it is topped up");
  }

  if (ONCE) {
    await pollOnce(reexecutor.id);
    return;
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce(reexecutor.id);
    } catch (err) {
      console.error(`${tag} poll failed, will retry:`, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
