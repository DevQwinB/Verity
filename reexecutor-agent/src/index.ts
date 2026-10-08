import "dotenv/config";
import "./net.js";
import { createHash } from "node:crypto";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as EscrowGateClient } from "escrow-gate";
import type { SubmissionRecord } from "escrow-gate";
import { REPLAY_ENGINE, ReplayInfrastructureError, runDeterministicFunction } from "./sandbox/runner.js";
import { hasConnectivity, RetrievalTransientError, runRetrieval } from "./sandbox/retrieval.js";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = requireEnv("ESCROW_GATE_CONTRACT_ID");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
// How long a retrieval target may stay unreachable before this worker
// concludes it is the target's fault (never longer than half the window).
const RETRIEVAL_RETRY_BUDGET_S = Number(process.env.RETRIEVAL_RETRY_BUDGET_S ?? 120);
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
  function_ref: string | null;
  input_ref: string | null;
  chain_submission_id: string;
}

/** 32 zero bytes: the recorded output hash when the declared work could not
 * be reproduced at all (it threw, exceeded the sandbox's limits, or its
 * artifacts are missing or malformed). That is itself a mismatch with
 * whatever the agent claimed. */
const NO_OUTPUT_HASH = "0".repeat(64);
const noOutput = (why: string) => ({ outputHash: NO_OUTPUT_HASH, engine: why });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** When this process first failed to reach a submission's retrieval target. */
const firstUnreachableAt = new Map<string, number>();

/**
 * Re-derives the output from the submission's own declared artifacts.
 *
 * A vote is bonded and irreversible, so the line between two kinds of
 * failure is the whole job here:
 *  - the *submission's* fault (it throws, exceeds the sandbox's limits, its
 *    spec is malformed, its target answers differently) resolves to a
 *    mismatch — an agent must not dodge a slash by submitting work that
 *    cannot be replayed;
 *  - *this worker's* trouble (backend or network unreachable, sandbox could
 *    not run on this host) throws instead. Nothing is voted and the
 *    assignment is retried on the next poll.
 *
 * What the agent committed to is read from the contract, not from the
 * backend: the task type, and the hash the input must have.
 */
async function reExecute(
  a: Assignment,
  record: SubmissionRecord
): Promise<{ outputHash: string; engine: string }> {
  if (!a.input_ref) return noOutput("none (no input artifact declared)");
  const inputBytes = await fetchArtifact(a.input_ref);
  if (createHash("sha256").update(inputBytes).digest("hex") !== hex(record.input_hash)) {
    // Not the agent's doing: the contract holds the right hash, the backend
    // handed over something else. Refuse to vote on the wrong input.
    throw new Error("backend served an input artifact that does not match the on-chain input_hash");
  }

  if (record.task_type.tag === "Retrieval") {
    let spec;
    try {
      spec = JSON.parse(inputBytes.toString("utf8"));
    } catch {
      return noOutput("retrieval failed: the request spec is not JSON");
    }
    try {
      return await runRetrieval(spec);
    } catch (err) {
      const message = (err as Error).message;
      if (!(err instanceof RetrievalTransientError)) return noOutput(`retrieval failed: ${message}`);

      const now = Date.now() / 1000;
      const first = firstUnreachableAt.get(a.chain_submission_id) ?? now;
      firstUnreachableAt.set(a.chain_submission_id, first);
      const budget = Math.min(RETRIEVAL_RETRY_BUDGET_S, Number(record.challenge_window_s) / 2);
      const giveUpAt = Math.max(Number(record.submitted_at), first) + budget;
      if (now < giveUpAt) {
        throw new Error(`retrieval inconclusive (${message}); retrying for another ${Math.ceil(giveUpAt - now)}s before judging`);
      }
      if (!(await hasConnectivity(CONNECTIVITY_CHECK_URL))) {
        throw new Error(`retrieval inconclusive (${message}) and this host has no outbound connectivity; not voting`);
      }
      return noOutput(`retrieval failed: target unreachable for ${Math.round(budget)}s while this host was online (${message})`);
    }
  }

  if (!a.function_ref) return noOutput("none (no function artifact declared)");
  const functionSource = (await fetchArtifact(a.function_ref)).toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(inputBytes.toString("utf8"));
  } catch {
    return noOutput("replay failed: the input artifact is not JSON");
  }
  try {
    return await runDeterministicFunction(functionSource, input);
  } catch (err) {
    if (err instanceof ReplayInfrastructureError) throw err;
    return noOutput(`replay failed: ${(err as Error).message}`);
  }
}

/** Submissions this process has already voted on. The backend keeps listing
 * an assignment until its indexer sees our ReplayAttested event a few
 * seconds later; without this we would re-run and re-send in the meantime. */
const attested = new Set<string>();

/** Set when the contract says this account may not vote at all (stake below
 * the floor, or not approved). Replaying is pointless until that changes, so
 * work is paused for a while instead of being retried every poll. */
let votingBlockedUntil = 0;

async function processAssignment(a: Assignment) {
  if (attested.has(a.chain_submission_id)) return;
  const record = (await client.get_submission({ id: BigInt(a.chain_submission_id) })).result;
  if (!record) throw new Error("submission is not on-chain (yet)");
  if (record.finalized) {
    attested.add(a.chain_submission_id);
    return;
  }

  console.log(`${tag} re-executing ${record.task_type.tag.toLowerCase()} submission #${a.chain_submission_id}`);
  const { outputHash, engine } = await reExecute(a, record);
  const claimed = hex(record.claimed_output_hash);
  const matched = outputHash === claimed;
  console.log(`${tag}   engine=${engine}`);
  console.log(`${tag}   output=${outputHash} claimed=${claimed} matched=${matched}`);

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
    const code = /Error\(Contract, #(\d+)\)/.exec((err as Error).message ?? "")?.[1];
    if (code === "20" || code === "27") {
      // #20 ReexecutorNotActive, #27 ReexecutorNotApproved.
      votingBlockedUntil = Date.now() + 60_000;
      console.warn(
        `${tag}   EscrowGate refused the vote: this account is ${code === "20" ? "not active (stake below the floor)" : "not approved as a voter"}. Pausing work for 60s.`
      );
      return;
    }
    // #23 AlreadyAttested: our vote is already on-chain. #32 ChallengeWindowClosed:
    // the submission was finalized before we got to it. Either way there is
    // nothing left for us to do for this submission.
    if (code !== "23" && code !== "32") throw err;
    console.log(`${tag}   nothing to do (already attested or already finalized)`);
  }
  attested.add(a.chain_submission_id);
  firstUnreachableAt.delete(a.chain_submission_id);
}

async function pollOnce(reexecutorId: string) {
  const { replay_assignments, spot_check_assignments } = await api<{
    replay_assignments: Assignment[];
    spot_check_assignments: Assignment[];
  }>(`/v1/reexecutors/${reexecutorId}/assignments`);
  // A sampled spot-check and a full replay are the same job for the worker:
  // re-derive the output, then put a bonded vote on-chain.
  // The poll above is what marks this worker online, so it runs even while
  // voting is blocked.
  if (Date.now() < votingBlockedUntil) return;
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
