import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { ConfigRecord, SubmissionRecord } from "escrow-gate";
import type { Kysely } from "kysely";
import type { Database } from "@verity/db";
import type { startTestDb } from "./db-harness.js";
import type { chain as chainSeam } from "../chain/seam.js";

// Env must be complete before any backend module is imported: config/env.ts
// exits the process on a missing variable. DATABASE_URL is a placeholder here
// (the pool is lazy) and is overwritten by startTestDb() before ../db.js is
// first imported. The chain is never contacted: every chain read goes through
// the seam, which the tests stub.
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", // replaced by the harness
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "x".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

/** The DB-backed worker suites only run with VERITY_DB_TESTS=1, so the default
 * `pnpm test` stays fast; CI sets the flag. */
export const DB_TESTS = process.env.VERITY_DB_TESTS === "1";

export interface WorkerDbContext {
  harness: Awaited<ReturnType<typeof startTestDb>>;
  /** The backend's db singleton — pointed at the test Postgres by the harness. */
  db: Kysely<Database>;
  chain: typeof chainSeam;
  indexer: typeof import("../workers/indexer.js");
  scheduler: typeof import("../workers/scheduler.js");
  verdict: typeof import("../modules/submissions/verdict.js");
}

/** Starts the embedded Postgres, migrates it, then imports the backend modules
 * (so their env-driven singletons pick up the test database). */
export async function setupWorkerDbTest(): Promise<WorkerDbContext> {
  const { startTestDb } = await import("./db-harness.js");
  const harness = await startTestDb();
  const { db } = await import("../db.js");
  const { chain } = await import("../chain/seam.js");
  const indexer = await import("../workers/indexer.js");
  const scheduler = await import("../workers/scheduler.js");
  const verdict = await import("../modules/submissions/verdict.js");
  return { harness, db, chain, indexer, scheduler, verdict };
}

/** Builds a chain SubmissionRecord stub; only the fields the workers read
 * matter. Fields accept either decoding shape (enum as `{tag}` or as a bare
 * array, which is what scValToNative produces for events). */
export function chainSubmissionRecord(fields: Record<string, unknown> = {}): SubmissionRecord {
  return {
    agent: "GAGENT",
    bond_amount: 50n,
    bonded_weight_matched: 0n,
    bonded_weight_mismatched: 0n,
    cfg_challenger_bond_min_bps: 500,
    cfg_quorum_min_reexecutors: 2,
    cfg_quorum_supermajority_bps: 6600,
    cfg_reexecutor_slash_bps: 0,
    cfg_slash_split_challenger_bps: 0,
    challenge_window_s: 600n,
    claimed_output_hash: Buffer.alloc(32),
    escrow_ref: Buffer.alloc(32),
    escrow_value: 1000n,
    finalized: false,
    id: 7n,
    input_hash: Buffer.alloc(32),
    match_votes: 0,
    mismatch_votes: 0,
    resolution_method: ["ReexecutionConsensus"],
    submitted_at: 1_700_000_000n,
    task_type: ["Deterministic"],
    verdict: ["Pending"],
    ...fields,
  } as unknown as SubmissionRecord;
}

export const GATE_CONFIG = {
  agent_bond_min_bps: 500,
  challenger_bond_min_bps: 500,
  min_stake_floor: 100n,
  quorum_min_reexecutors: 2,
  quorum_supermajority_bps: 6600,
  reexecutor_allowlist: false,
  reexecutor_slash_bps: 0,
  ...({} as object),
} as unknown as ConfigRecord;

/**
 * Replaces every chain seam member with a hermetic stub; `overrides` wins.
 * Returns the stubs that record calls, for assertions.
 */
export function stubChain(
  chain: WorkerDbContext["chain"],
  overrides: Partial<Record<keyof WorkerDbContext["chain"], unknown>> = {}
) {
  const calls = {
    finalize: 0,
    resolveChallenge: 0,
    releaseLock: [] as string[],
  };
  chain.readSubmission = async () => chainSubmissionRecord();
  chain.finalizeOnChain = async () => {
    calls.finalize++;
    return { status: "verified", txHash: "stub-finalize-tx" };
  };
  chain.resolveChallengeOnChain = async () => {
    calls.resolveChallenge++;
    return { status: "verified", txHash: "stub-resolve-tx" };
  };
  chain.releaseAttestationLockOnChain = async (_id: string, reexecutor: string) => {
    calls.releaseLock.push(reexecutor);
    return "stub-release-tx";
  };
  chain.reexecutorInfo = async () => ({
    result: { stake_amount: 80n, active: true, approved: true },
  });
  chain.getGateConfig = async () => GATE_CONFIG;
  Object.assign(chain, overrides);
  return calls;
}

// --- row seeders -----------------------------------------------------------

export async function seedMarketplace(db: Kysely<Database>, account = "GMARKETPLACE") {
  return db
    .insertInto("marketplace")
    .values({ stellar_account: account, name: "test market" })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedReexecutor(
  db: Kysely<Database>,
  account: string,
  opts: { active?: boolean; approved?: boolean; lastSeenAt?: Date | null; slashedCount?: number } = {}
) {
  return db
    .insertInto("reexecutor")
    .values({
      stellar_account: account,
      stake_amount: "1000",
      stake_asset: "native",
      active: opts.active ?? true,
      approved: opts.approved ?? true,
      last_seen_at: opts.lastSeenAt === undefined ? new Date() : opts.lastSeenAt,
      ...(opts.slashedCount !== undefined ? { slashed_count: opts.slashedCount } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedSubmission(
  db: Kysely<Database>,
  marketplaceId: string,
  overrides: Record<string, unknown> = {}
) {
  return db
    .insertInto("submission")
    .values({
      escrow_ref: "escrow-1",
      marketplace_id: marketplaceId,
      agent_id: "GAGENT",
      task_type: "deterministic",
      input_hash: "aa".repeat(32),
      claimed_output_hash: "bb".repeat(32),
      bond_amount: "50",
      bond_asset: "native",
      challenge_window_s: 600,
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedWebhookSubscription(
  db: Kysely<Database>,
  marketplaceId: string,
  events: string[]
) {
  return db
    .insertInto("webhook_subscription")
    .values({
      marketplace_id: marketplaceId,
      url: "https://hooks.invalid/verity", // .invalid never resolves; the delivery row is what we count
      secret: "whsec",
      events,
      active: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** dispatchWebhook is fire-and-forget, so poll briefly for the delivery row. */
export async function deliveryCount(
  db: Kysely<Database>,
  eventType: string,
  timeoutMs = 3000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db
      .selectFrom("webhook_delivery")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("event_type", "=", eventType)
      .executeTakeFirst();
    const count = Number(row?.count ?? 0);
    if (count > 0 || Date.now() > deadline) return count;
    await new Promise((r) => setTimeout(r, 25));
  }
}
