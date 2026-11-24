import "dotenv/config";
import "./net.js";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as EscrowGateClient } from "escrow-gate";
import { REPLAY_ENGINE, runDeterministicFunction } from "./sandbox/runner.js";
import { hasConnectivity, runRetrieval } from "./sandbox/retrieval.js";
import { assertSep10Challenge } from "./sep10.js";
import { startHeartbeat } from "./heartbeat.js";
import { createWorker } from "./worker.js";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = requireEnv("ESCROW_GATE_CONTRACT_ID");
const POLL_MS = numberEnv("POLL_INTERVAL_MS", 3000, 250);
/** Well inside the backend's REEXECUTOR_LIVENESS_S (default 60 s). */
const HEARTBEAT_MS = numberEnv("HEARTBEAT_INTERVAL_MS", 15_000, 1000);
// How long a retrieval target may stay unreachable before this worker
// concludes it is the target's fault (never longer than half the window).
const RETRIEVAL_RETRY_BUDGET_S = numberEnv("RETRIEVAL_RETRY_BUDGET_S", 120, 1);
// Any endpoint this worker must be able to reach anyway. If even this fails,
// the problem is our network, and an unreachable target proves nothing.
const CONNECTIVITY_CHECK_URL = process.env.CONNECTIVITY_CHECK_URL ?? RPC_URL;
const ONCE = process.argv.includes("--once");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[reexecutor-agent] ${name} is required (see reexecutor-agent/.env.example)`);
    process.exit(1);
  }
  return value;
}

/** A numeric setting: unset or empty uses `fallback`; anything else must be a
 * finite number >= `min`, or the agent refuses to start. A bare `Number(...)`
 * turned a typo into NaN, i.e. a 1 ms poll loop or no retrieval retry wait. */
function numberEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`[reexecutor-agent] ${name} must be a number >= ${min} (got "${raw}")`);
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
  if (!challengeRes.ok) throw new Error(`SEP-10 challenge request failed: HTTP ${challengeRes.status}`);
  const { transaction } = (await challengeRes.json()) as { transaction: string };
  const tx = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
  assertSep10Challenge(tx, publicKey);
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

const worker = createWorker({
  api,
  getSubmission: async (id) => (await client.get_submission({ id })).result,
  attest: async ({ submissionId, outputHash, matched }) => {
    const tx = await client.attest_replay({
      reexecutor: publicKey,
      submission_id: submissionId,
      output_hash: outputHash,
      matched,
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { hash: sent.sendTransactionResponse?.hash };
  },
  fetchArtifact,
  runDeterministicFunction,
  runRetrieval,
  hasConnectivity,
  config: {
    retryBudgetS: RETRIEVAL_RETRY_BUDGET_S,
    connectivityUrl: CONNECTIVITY_CHECK_URL,
  },
  publicKey,
});

async function main() {
  console.log(`[reexecutor-agent] starting as ${publicKey}`);
  console.log(`[reexecutor-agent] replay engine: ${REPLAY_ENGINE}`);
  // Mirrors this account's real on-chain stake into the backend, so an
  // account staked by script (or long ago) is assignable without re-staking.
  const { reexecutor } = await api<{
    reexecutor: { id: string; active: boolean; approved: boolean; stake_amount: string };
  }>("/v1/reexecutors/sync", { method: "POST" });
  console.log(
    `[reexecutor-agent] reexecutor_id=${reexecutor.id} stake=${reexecutor.stake_amount} stroops active=${reexecutor.active} approved=${reexecutor.approved}`
  );
  if (!reexecutor.active) {
    console.warn("[reexecutor-agent] stake is below the on-chain floor — no work will be assigned until it is topped up");
  }
  if (!reexecutor.approved) {
    console.warn("[reexecutor-agent] not approved as a voter — on a deployment with the allow-list on, no work is assigned until the admin approves this account");
  }

  if (ONCE) {
    await worker.pollOnce(reexecutor.id);
    return;
  }
  // A replay can run for minutes; the assignment poll cannot, so liveness
  // is reported on its own timer. A backend that predates the endpoint
  // answers 404 and the poll keeps the worker online as before.
  startHeartbeat(
    () => api<unknown>(`/v1/reexecutors/${reexecutor.id}/heartbeat`, { method: "POST" }).then(() => {}),
    HEARTBEAT_MS,
    (err) => console.warn(`${tag} heartbeat failed (the assignment poll still reports liveness):`, err.message)
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await worker.pollOnce(reexecutor.id);
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
