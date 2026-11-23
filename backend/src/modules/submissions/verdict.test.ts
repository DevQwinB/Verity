import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { EnqueuedWebhook } from "../webhooks/dispatcher.js";

const contractId = StrKey.encodeContract(Buffer.alloc(32));

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: contractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: contractId,
  BOND_ASSET_CONTRACT_ID: contractId,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { recordTerminalVerdict } = await import("./verdict.js");

interface FakeSubmission {
  id: string;
  status: string;
  marketplace_id: string;
  chain_submission_id: string | null;
  resolution_method: string | null;
  finalize_tx_hash: string | null;
  updated_at: Date;
}

function createMockDb(initial: FakeSubmission[]) {
  const submissions = new Map<string, FakeSubmission>(initial.map((s) => [s.id, { ...s }]));
  let inTransaction = false;

  const createOps = () => ({
    updateTable: (table: string) => {
      if (table === "submission") {
        let updateSet: any = {};
        let targetId: string | null = null;
        let notStatus: string | null = null;

        const builder: any = {
          set: (vals: any) => {
            updateSet = vals;
            return builder;
          },
          where: (col: string, op: string, val: any) => {
            if (col === "id" && op === "=") targetId = val;
            if (col === "status" && op === "!=") notStatus = val;
            return builder;
          },
          returningAll: () => builder,
          executeTakeFirst: async () => {
            if (!targetId) return undefined;
            const existing = submissions.get(targetId);
            if (!existing) return undefined;
            if (notStatus && existing.status === notStatus) {
              return undefined;
            }
            const updated = { ...existing, ...updateSet };
            submissions.set(targetId, updated);
            return updated;
          },
          execute: async () => {
            if (!targetId) return;
            const existing = submissions.get(targetId);
            if (!existing) return;
            submissions.set(targetId, { ...existing, ...updateSet });
          },
        };
        return builder;
      }
      if (table === "challenge") {
        const builder: any = {
          set: () => builder,
          where: () => builder,
          execute: async () => {},
        };
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    selectFrom: (table: string) => {
      if (table === "submission") {
        let targetId: string | null = null;
        const builder: any = {
          selectAll: () => builder,
          where: (col: string, op: string, val: any) => {
            if (col === "id" && op === "=") targetId = val;
            return builder;
          },
          executeTakeFirst: async () => {
            if (!targetId) return undefined;
            return submissions.get(targetId);
          },
        };
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  });

  return {
    submissions,
    getInTransaction: () => inTransaction,
    transaction: () => ({
      execute: async <T>(callback: (trx: any) => Promise<T>): Promise<T> => {
        inTransaction = true;
        const snapshot = new Map(Array.from(submissions.entries()).map(([k, v]) => [k, { ...v }]));
        try {
          const res = await callback(createOps());
          inTransaction = false;
          return res;
        } catch (err) {
          submissions.clear();
          for (const [k, v] of snapshot.entries()) {
            submissions.set(k, v);
          }
          inTransaction = false;
          throw err;
        }
      },
    }),
    ...createOps(),
  };
}

test("if enqueueWebhook fails, the status transition rolls back and the next call retries both", async () => {
  const subId = "sub-test-1";
  const mockDb = createMockDb([
    {
      id: subId,
      status: "pending",
      marketplace_id: "mkt-1",
      chain_submission_id: "1",
      resolution_method: null,
      finalize_tx_hash: null,
      updated_at: new Date(),
    },
  ]);

  let shouldFailEnqueue = true;
  let enqueueCalls = 0;
  const attemptedDeliveries: string[] = [];

  const fakeEnqueue = async (_trx: any, _mktId: string, _eventType: string, _payload: any): Promise<EnqueuedWebhook[]> => {
    enqueueCalls++;
    if (shouldFailEnqueue) {
      throw new Error("57P01: Postgres connection lost during webhook delivery insert");
    }
    return [
      {
        delivery: {
          id: "del-1",
          subscription_id: "sub-sub-1",
          event_type: "submission.verified",
          payload: { submission_id: subId },
          status: "pending",
          attempts: 0,
          last_attempt_at: null,
          response_code: null,
          created_at: new Date() as any,
        },
        subscription: {
          id: "sub-sub-1",
          marketplace_id: "mkt-1",
          url: "https://example.com/webhook",
          secret: "secret123",
          events: ["submission.verified"],
          active: true,
        },
      },
    ];
  };

  const fakeAttempt = async (delivery: any) => {
    attemptedDeliveries.push(delivery.id);
  };

  const fakeReadSubmission = async () => null;

  // First call: enqueue fails
  await assert.rejects(
    recordTerminalVerdict(subId, "verified", "tx-123", {
      db: mockDb as any,
      enqueueWebhook: fakeEnqueue as any,
      attemptDelivery: fakeAttempt as any,
      readSubmission: fakeReadSubmission as any,
    }),
    /57P01/
  );

  // Status must NOT be committed due to rollback
  assert.equal(mockDb.submissions.get(subId)?.status, "pending");
  assert.equal(enqueueCalls, 1);
  assert.equal(attemptedDeliveries.length, 0);

  // Next call: enqueue succeeds
  shouldFailEnqueue = false;
  await recordTerminalVerdict(subId, "verified", "tx-123", {
    db: mockDb as any,
    enqueueWebhook: fakeEnqueue as any,
    attemptDelivery: fakeAttempt as any,
    readSubmission: fakeReadSubmission as any,
  });

  // Now both the status transition and delivery rows are committed
  assert.equal(mockDb.submissions.get(subId)?.status, "verified");
  assert.equal(enqueueCalls, 2);
  assert.deepEqual(attemptedDeliveries, ["del-1"]);
});

test("exactly one set of delivery rows is created across multiple concurrent calls", async () => {
  const subId = "sub-test-2";
  const mockDb = createMockDb([
    {
      id: subId,
      status: "pending",
      marketplace_id: "mkt-1",
      chain_submission_id: "2",
      resolution_method: null,
      finalize_tx_hash: null,
      updated_at: new Date(),
    },
  ]);

  let enqueueCalls = 0;
  const attemptedDeliveries: string[] = [];

  const fakeEnqueue = async (_trx: any): Promise<EnqueuedWebhook[]> => {
    enqueueCalls++;
    return [
      {
        delivery: {
          id: `del-${enqueueCalls}`,
          subscription_id: "sub-sub-1",
          event_type: "submission.verified",
          payload: { submission_id: subId },
          status: "pending",
          attempts: 0,
          last_attempt_at: null,
          response_code: null,
          created_at: new Date() as any,
        },
        subscription: {
          id: "sub-sub-1",
          marketplace_id: "mkt-1",
          url: "https://example.com/webhook",
          secret: "secret123",
          events: ["submission.verified"],
          active: true,
        },
      },
    ];
  };

  const fakeAttempt = async (delivery: any) => {
    attemptedDeliveries.push(delivery.id);
  };

  const fakeReadSubmission = async () => null;

  // First call (e.g. from indexer)
  await recordTerminalVerdict(subId, "verified", "tx-1", {
    db: mockDb as any,
    enqueueWebhook: fakeEnqueue as any,
    attemptDelivery: fakeAttempt as any,
    readSubmission: fakeReadSubmission as any,
  });

  // Second call (e.g. from scheduler reconcile)
  await recordTerminalVerdict(subId, "verified", "tx-1", {
    db: mockDb as any,
    enqueueWebhook: fakeEnqueue as any,
    attemptDelivery: fakeAttempt as any,
    readSubmission: fakeReadSubmission as any,
  });

  // Exactly one enqueue was executed
  assert.equal(enqueueCalls, 1);
  assert.deepEqual(attemptedDeliveries, ["del-1"]);
});

test("readSubmission is executed outside the transaction", async () => {
  const subId = "sub-test-3";
  const mockDb = createMockDb([
    {
      id: subId,
      status: "pending",
      marketplace_id: "mkt-1",
      chain_submission_id: "3",
      resolution_method: null,
      finalize_tx_hash: null,
      updated_at: new Date(),
    },
  ]);

  let readInsideTx: boolean | null = null;
  const fakeReadSubmission = async () => {
    readInsideTx = mockDb.getInTransaction();
    return null;
  };

  await recordTerminalVerdict(subId, "verified", "tx-3", {
    db: mockDb as any,
    enqueueWebhook: (async () => []) as any,
    attemptDelivery: (async () => {}) as any,
    readSubmission: fakeReadSubmission as any,
  });

  assert.equal(readInsideTx, false, "readSubmission must be called outside the transaction");
});
