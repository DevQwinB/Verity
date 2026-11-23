import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

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

const {
  evaluateContractMatch,
  checkContractMatch,
  assertContractMatch,
} = await import("./contract-guard.js");

describe("evaluateContractMatch", () => {
  const currentContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const oldContract = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB4EM4";

  it("passes when cursor list is empty (fresh database)", () => {
    const res = evaluateContractMatch(currentContract, [], false);
    assert.equal(res.ok, true);
  });

  it("passes when only the current contract is present in cursors", () => {
    const res = evaluateContractMatch(currentContract, [currentContract], true);
    assert.equal(res.ok, true);
  });

  it("passes when another contract cursor exists but there are no chain submissions", () => {
    const res = evaluateContractMatch(currentContract, [oldContract], false);
    assert.equal(res.ok, true);
  });

  it("rejects when another contract cursor exists and chain submissions exist", () => {
    const res = evaluateContractMatch(currentContract, [oldContract], true);
    assert.equal(res.ok, false);
    assert.equal(res.mismatchedContractId, oldContract);
    assert.ok(res.error?.includes(oldContract));
    assert.ok(res.error?.includes(currentContract));
    assert.ok(res.error?.includes("pnpm db:reset"));
    assert.ok(res.error?.includes("manual migration"));
  });
});

describe("checkContractMatch", () => {
  const currentContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const oldContract = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB4EM4";

  function createMockDb(cursorRow: { contract_id: string } | undefined, submissionRow: { id: string } | undefined) {
    return {
      selectFrom(table: "chain_cursor" | "submission") {
        return {
          select() {
            return {
              where() {
                return {
                  limit() {
                    return {
                      async executeTakeFirst() {
                        return table === "chain_cursor" ? cursorRow : submissionRow;
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  it("passes when chain_cursor has no other contract", async () => {
    const mockDb = createMockDb(undefined, undefined);
    const res = await checkContractMatch(currentContract, mockDb as any);
    assert.equal(res.ok, true);
  });

  it("passes when chain_cursor has another contract but submission has no chain state", async () => {
    const mockDb = createMockDb({ contract_id: oldContract }, undefined);
    const res = await checkContractMatch(currentContract, mockDb as any);
    assert.equal(res.ok, true);
  });

  it("fails when chain_cursor has another contract and submissions have chain state", async () => {
    const mockDb = createMockDb({ contract_id: oldContract }, { id: "sub-123" });
    const res = await checkContractMatch(currentContract, mockDb as any);
    assert.equal(res.ok, false);
    assert.equal(res.mismatchedContractId, oldContract);
    assert.ok(res.error?.includes("pnpm db:reset"));
  });
});

describe("assertContractMatch", () => {
  const currentContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const oldContract = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB4EM4";

  it("does not call exit when match succeeds", async () => {
    let exitCalled = false;
    const mockDb = {
      selectFrom() {
        return {
          select: () => ({ where: () => ({ limit: () => ({ executeTakeFirst: async () => undefined }) }) }),
        };
      },
    };

    await assertContractMatch(currentContract, {
      database: mockDb as any,
      exit: () => {
        exitCalled = true;
      },
    });
    assert.equal(exitCalled, false);
  });

  it("logs error and calls exit(1) when match fails", async () => {
    let exitCode: number | null = null;
    let loggedError: string | null = null;

    const mockDb = {
      selectFrom(table: string) {
        return {
          select: () => ({
            where: () => ({
              limit: () => ({
                executeTakeFirst: async () => (table === "chain_cursor" ? { contract_id: oldContract } : { id: "sub-1" }),
              }),
            }),
          }),
        };
      },
    };

    await assertContractMatch(currentContract, {
      database: mockDb as any,
      logger: {
        error: (msg) => {
          loggedError = msg;
        },
      },
      exit: (code) => {
        exitCode = code;
      },
    });

    assert.equal(exitCode, 1);
    assert.ok(loggedError);
    assert.ok((loggedError as string).includes(oldContract));
    assert.ok((loggedError as string).includes("pnpm db:reset"));
  });
});
