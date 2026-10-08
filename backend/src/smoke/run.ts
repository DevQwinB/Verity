import "dotenv/config";
import { createHash } from "node:crypto";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../config/env.js";

/**
 * Real, end-to-end proof that the whole system works against Stellar
 * testnet: SEP-10 login, artifact upload, a real submit(), real
 * reexecutor-agent processes replaying and attesting on-chain, the indexer
 * reconciling it, the keeper finalizing/resolving/settling. Nothing here is
 * mocked, and this script never attests on a re-executor's behalf — it only
 * plays the agent and the challenger, then watches what the system does.
 *
 * Prerequisite: the stack is running with re-executor agents
 * (`pnpm dev`), i.e. at least quorum_min_reexecutors staked agents polling.
 *
 *   SMOKE_AGENT_SECRET       funded testnet account that submits work
 *   SMOKE_CHALLENGER_SECRET  funded testnet account that opens a challenge
 *   SMOKE_ONLY               optional comma-separated scenario names
 */

const BASE = process.env.SMOKE_BACKEND_URL ?? `http://127.0.0.1:${env.PORT}`;
const XLM = 10_000_000n;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = any>(path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data as T;
}

async function login(keypair: Keypair): Promise<string> {
  const { transaction } = await call(`/auth?account=${keypair.publicKey()}`);
  const tx = TransactionBuilder.fromXDR(transaction, env.NETWORK_PASSPHRASE);
  tx.sign(keypair);
  const { token } = await call("/auth", { body: { transaction: tx.toXDR() } });
  return token;
}

function sign(unsignedXdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, env.NETWORK_PASSPHRASE);
  tx.sign(keypair);
  return tx.toXDR();
}

async function upload(token: string, content: string): Promise<{ content_hash: string; storage_ref: string }> {
  return call("/v1/artifacts", { token, body: { content_base64: Buffer.from(content).toString("base64") } });
}

interface Actor {
  keypair: Keypair;
  token: string;
}

async function submit(
  agent: Actor,
  name: string,
  task:
    | { type: "deterministic"; functionSource: string; input: unknown; claimedOutput: unknown }
    | { type: "retrieval"; spec: { url: string; pointer?: string }; claimedOutput: unknown }
): Promise<string> {
  const inputJson = canonicalJson(task.type === "deterministic" ? task.input : task.spec);
  const input = await upload(agent.token, inputJson);
  const outputJson = canonicalJson(task.claimedOutput);
  const output = await upload(agent.token, outputJson);
  const fn = task.type === "deterministic" ? await upload(agent.token, task.functionSource) : null;

  const key = `smoke-${name}-${Date.now()}`;
  const created = await call("/v1/submissions", {
    token: agent.token,
    body: {
      escrow_ref: key,
      task_type: task.type,
      input_hash: input.content_hash,
      input_ref: input.storage_ref,
      claimed_output_hash: output.content_hash,
      claimed_output_ref: output.storage_ref,
      function_hash: fn?.content_hash,
      function_ref: fn?.storage_ref,
      escrow_value: String(100n * XLM),
      bond_amount: String(5n * XLM),
      idempotency_key: key,
    },
  });
  const relayed = await call(`/v1/submissions/${created.submission.id}/relay`, {
    token: agent.token,
    body: { signed_transaction_xdr: sign(created.unsigned_transaction_xdr, agent.keypair) },
  });
  console.log(`  submit() tx ${relayed.tx_hash} -> on-chain submission #${relayed.submission.chain_submission_id}`);
  return created.submission.id as string;
}

async function waitFor<T>(what: string, timeoutS: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(3000);
  }
  throw new Error(`timed out after ${timeoutS}s waiting for: ${what}`);
}

const detail = (id: string) => call(`/v1/submissions/${id}`);

async function expectVerdict(id: string, expected: "verified" | "slashed") {
  const d = await waitFor(`terminal verdict on ${id}`, 180, async () => {
    const cur = await detail(id);
    return cur.submission.status === "verified" || cur.submission.status === "slashed" ? cur : null;
  });
  if (d.submission.status !== expected) throw new Error(`expected ${expected}, got ${d.submission.status}`);
  // Settlement waits for the indexer to have recorded every on-chain vote,
  // so the tally printed here is the complete one.
  const settled = await waitFor(`settlement (attestation locks released) on ${id}`, 180, async () => {
    const cur = await detail(id);
    return cur.submission.settled_at ? cur : null;
  });
  const votes = settled.replays.filter((r: any) => r.status === "confirmed_onchain");
  console.log(`  verdict=${expected} from ${votes.length} on-chain attestation(s): ${votes.map((r: any) => (r.match ? "match" : "mismatch")).join(", ")}`);
  console.log("  settled: re-executor attestation locks released on-chain");
  return settled;
}

const DOUBLE = "return { doubled: input.n * 2, source: 'replay' };";

const scenarios: Record<string, (agent: Actor, challenger: Actor) => Promise<void>> = {
  async "honest-deterministic"(agent) {
    const id = await submit(agent, "honest", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 21 },
      // Key order deliberately differs from the function's — canonical
      // hashing must make that irrelevant.
      claimedOutput: { source: "replay", doubled: 42 },
    });
    await expectVerdict(id, "verified");
  },

  async "dishonest-deterministic"(agent) {
    const id = await submit(agent, "dishonest", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 21 },
      claimedOutput: { source: "replay", doubled: 9000 },
    });
    await expectVerdict(id, "slashed");
  },

  async "challenged-honest"(agent, challenger) {
    const id = await submit(agent, "challenged", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 4 },
      claimedOutput: { doubled: 8, source: "replay" },
    });
    const built = await call(`/v1/submissions/${id}/challenge`, {
      token: challenger.token,
      body: { bond: String(5n * XLM) },
    });
    const relayed = await call(`/v1/submissions/${id}/challenge/relay`, {
      token: challenger.token,
      body: { signed_transaction_xdr: sign(built.unsigned_transaction_xdr, challenger.keypair) },
    });
    console.log(`  open_challenge() tx ${relayed.tx_hash}`);
    await waitFor("indexer to record the challenge", 60, async () => (await detail(id)).challenge);
    const d = await expectVerdict(id, "verified");
    const challenge = (await detail(id)).challenge;
    console.log(`  challenge resolution=${challenge.resolution} via ${challenge.resolution_method}`);
    if (challenge.resolution !== "rejected") throw new Error(`expected challenge rejected, got ${challenge.resolution}`);
    void d;
  },

  async "honest-retrieval"(agent) {
    const id = await submit(agent, "retrieval-ok", {
      type: "retrieval",
      spec: { url: "https://horizon-testnet.stellar.org/", pointer: "/network_passphrase" },
      claimedOutput: env.NETWORK_PASSPHRASE,
    });
    const check = await waitFor("spot-check result", 120, async () => {
      const d = await detail(id);
      return d.spot_checks.find((s: any) => s.result) ?? null;
    });
    console.log(`  spot-check result=${check.result} (sampled re-executor re-fetched the endpoint and attested on-chain)`);
    if (check.result !== "match") throw new Error(`expected spot-check match, got ${check.result}`);
    const d = await detail(id);
    console.log(`  status=${d.submission.status} — optimistic: auto-verifies when its ${d.submission.challenge_window_s}s challenge window closes`);
    if (d.submission.status !== "pending") throw new Error(`expected pending, got ${d.submission.status}`);
  },

  async "dishonest-retrieval"(agent) {
    const id = await submit(agent, "retrieval-bad", {
      type: "retrieval",
      spec: { url: "https://horizon-testnet.stellar.org/", pointer: "/network_passphrase" },
      claimedOutput: "a fabricated answer the agent never retrieved",
    });
    const d = await expectVerdict(id, "slashed");
    const check = d.spot_checks.find((s: any) => s.result);
    console.log(`  spot-check result=${check?.result} -> escalated to a full replay quorum`);
    if (check?.result !== "mismatch") throw new Error("expected a spot-check mismatch to have triggered the escalation");
  },
};

async function main() {
  const agentSecret = process.env.SMOKE_AGENT_SECRET;
  const challengerSecret = process.env.SMOKE_CHALLENGER_SECRET;
  if (!agentSecret || !challengerSecret) {
    throw new Error("SMOKE_AGENT_SECRET and SMOKE_CHALLENGER_SECRET are required (scripts/smoke.sh sets them from your stellar-cli identities)");
  }
  const agentKp = Keypair.fromSecret(agentSecret);
  const challengerKp = Keypair.fromSecret(challengerSecret);
  const agent: Actor = { keypair: agentKp, token: await login(agentKp) };
  const challenger: Actor = { keypair: challengerKp, token: await login(challengerKp) };
  console.log(`[smoke] backend    ${BASE}`);
  console.log(`[smoke] agent      ${agentKp.publicKey()}`);
  console.log(`[smoke] challenger ${challengerKp.publicKey()}`);

  const active = ((await call("/v1/reexecutors")) as any[]).filter((r) => r.active);
  console.log(`[smoke] ${active.length} active re-executor(s) registered`);
  if (active.length < 3) throw new Error("need at least 3 active re-executors — is `pnpm dev` running with its agents?");

  const only = (process.env.SMOKE_ONLY ?? "").split(",").filter(Boolean);
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const [name, run] of Object.entries(scenarios)) {
    if (only.length > 0 && !only.includes(name)) continue;
    console.log(`\n[smoke] scenario: ${name}`);
    try {
      await run(agent, challenger);
      results.push({ name, ok: true });
      console.log("  PASS");
    } catch (err) {
      results.push({ name, ok: false, error: (err as Error).message });
      console.error(`  FAIL: ${(err as Error).message}`);
    }
  }

  console.log("\n=== SMOKE TEST RESULT ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.error ? `  — ${r.error}` : ""}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
