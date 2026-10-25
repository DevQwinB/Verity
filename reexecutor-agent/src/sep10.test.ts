import test from "node:test";
import assert from "node:assert/strict";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { assertSep10Challenge } from "./sep10.js";

const server = Keypair.random();
const me = Keypair.random().publicKey();

function build(sequence: string, ops: ReturnType<typeof Operation.manageData>[] | ReturnType<typeof Operation.payment>[]) {
  const builder = new TransactionBuilder(new Account(server.publicKey(), sequence), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  return builder.build();
}

// The builder bumps the sequence by one, so "-1" yields a transaction at 0 like a real challenge.
const challengeOp = () => Operation.manageData({ name: "localhost auth", value: "nonce", source: me });

test("accepts a SEP-10 shaped challenge", () => {
  const tx = build("-1", [challengeOp(), Operation.manageData({ name: "web_auth_domain", value: "localhost", source: server.publicKey() })]);
  assert.equal(tx.sequence, "0");
  assert.doesNotThrow(() => assertSep10Challenge(tx, me));
});

test("refuses a transaction with a real sequence number", () => {
  const tx = build("100", [challengeOp()]);
  assert.throws(() => assertSep10Challenge(tx, me), /non-zero sequence/);
});

test("refuses a payment, even at sequence 0", () => {
  const pay = Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1", source: me });
  const tx = build("-1", [pay]);
  assert.throws(() => assertSep10Challenge(tx, me), /other than manageData/);
});

test("refuses a challenge that names a different account", () => {
  const tx = build("-1", [Operation.manageData({ name: "localhost auth", value: "nonce", source: Keypair.random().publicKey() })]);
  assert.throws(() => assertSep10Challenge(tx, me), /does not name this account/);
});

test("refuses a fee bump", () => {
  const inner = build("100", [challengeOp()]);
  inner.sign(server);
  const bump = TransactionBuilder.buildFeeBumpTransaction(server, "200", inner, Networks.TESTNET);
  assert.throws(() => assertSep10Challenge(bump, me), /fee bump/);
});
