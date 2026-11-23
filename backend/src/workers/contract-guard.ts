import type { Kysely } from "kysely";
import type { Database } from "@verity/db";
import { db as defaultDb } from "../db.js";

export interface ContractMatchDecision {
  ok: boolean;
  mismatchedContractId?: string;
  expectedContractId: string;
  error?: string;
}

/** Pure decision helper for contract guard. */
export function evaluateContractMatch(
  expectedContractId: string,
  cursorContractIds: string[],
  hasSubmissionsWithChainId: boolean
): ContractMatchDecision {
  const mismatched = cursorContractIds.find((id) => id !== expectedContractId);
  if (mismatched && hasSubmissionsWithChainId) {
    const error =
      `Database mirrors a different EscrowGate contract (${mismatched}) than configured (${expectedContractId}) ` +
      `and contains submissions with mirrored chain state. ` +
      `Refusing to run workers to prevent state corruption. ` +
      `Run 'pnpm db:reset' for local development or perform a manual migration for a shared database.`;
    return {
      ok: false,
      mismatchedContractId: mismatched,
      expectedContractId,
      error,
    };
  }
  return { ok: true, expectedContractId };
}

export interface ContractGuardDatabase {
  selectFrom: (table: "chain_cursor" | "submission") => any;
}

/** Queries database to check whether chain_cursor mirrors a different contract while chain submissions exist. */
export async function checkContractMatch(
  expectedContractId: string,
  database: Kysely<Database> | ContractGuardDatabase = defaultDb
): Promise<ContractMatchDecision> {
  const otherCursor = await (database as Kysely<Database>)
    .selectFrom("chain_cursor")
    .select(["contract_id"])
    .where("contract_id", "!=", expectedContractId)
    .limit(1)
    .executeTakeFirst();

  if (!otherCursor) {
    return { ok: true, expectedContractId };
  }

  const existingSub = await (database as Kysely<Database>)
    .selectFrom("submission")
    .select(["id"])
    .where("chain_submission_id", "is not", null)
    .limit(1)
    .executeTakeFirst();

  return evaluateContractMatch(
    expectedContractId,
    [otherCursor.contract_id],
    Boolean(existingSub)
  );
}

export interface AssertContractMatchOptions {
  database?: Kysely<Database> | ContractGuardDatabase;
  logger?: { error: (msg: string) => void };
  exit?: (code: number) => void | Promise<void> | never;
}

/** Asserts contract match and exits if mismatched. */
export async function assertContractMatch(
  expectedContractId: string,
  options?: AssertContractMatchOptions
): Promise<void> {
  const database = options?.database ?? defaultDb;
  const result = await checkContractMatch(expectedContractId, database);
  if (!result.ok) {
    const log = options?.logger?.error ?? console.error;
    log(result.error!);
    const exitFn = options?.exit ?? process.exit;
    await exitFn(1);
  }
}
