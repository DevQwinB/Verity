import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, TransactionBuilder, WebAuth, xdr } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";

// sep10.ts imports the validated environment and the keeper at module load
// time. Set all required fields before its first dynamic import; never reuse
// a developer's .env secrets or contact the Soroban RPC in these tests.
const keeper = Keypair.random();
const server = Keypair.random();
const client = Keypair.random();
const other = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";
const homeDomain = "localhost";
const webAuthDomain = "localhost:3001";
const jwtSecret = "a".repeat(32);

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  SEP10_SIGNING_SECRET: server.secret(),
  JWT_SECRET: jwtSecret,
  WEB_AUTH_DOMAIN: webAuthDomain,
  HOME_DOMAIN: homeDomain,
});

const Fastify = (await import("fastify")).default;
const { HttpError } = await import("../http-error.js");
const { buildChallenge, verifyChallenge, issueJwt, verifyJwt, sep10SigningKey } =
  await import("./sep10.js");
const { authPlugin } = await import("./plugin.js");

function signChallenge(xdrStr: string, signer: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdrStr, passphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function customChallenge(
  signingKey: Keypair,
  home: string = homeDomain,
  webAuth: string = webAuthDomain,
): string {
  return WebAuth.buildChallengeTx(
    signingKey,
    client.publicKey(),
    home,
    300,
    passphrase,
    webAuth,
  );
}

const noAccount = async () => null;

function mockAccountEntry(options: {
  accountId: string;
  masterWeight: number;
  mediumThreshold: number;
  signers?: Array<{ publicKey: string; weight: number }>;
}): xdr.AccountEntry {
  const signers = (options.signers ?? []).map((s) => {
    const raw = Keypair.fromPublicKey(s.publicKey).rawPublicKey();
    return new xdr.Signer({
      key: xdr.SignerKey.signerKeyTypeEd25519(raw),
      weight: s.weight,
    });
  });

  return new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(options.accountId).xdrPublicKey(),
    balance: 100n,
    seqNum: 1n,
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    thresholds: Buffer.from([options.masterWeight, 1, options.mediumThreshold, 2]),
    signers,
    ext: xdr.AccountEntryExt.v0(),
  });
}

test("SEP-10 signs using its dedicated signing key", () => {
  assert.equal(sep10SigningKey, server.publicKey());
  assert.notEqual(sep10SigningKey, keeper.publicKey());
});

test("SEP-10 accepts a valid challenge signed by its claimed client", async () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), client);
  assert.deepEqual(await verifyChallenge(signed, noAccount), { account: client.publicKey() });
});

test("SEP-10 rejects a challenge that has only the server signature", async () => {
  await assert.rejects(
    async () => verifyChallenge(buildChallenge(client.publicKey(), homeDomain), noAccount),
    /None of the given signers match/,
  );
});

test("SEP-10 rejects a challenge signed by an unrelated account", async () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), other);
  await assert.rejects(async () => verifyChallenge(signed, noAccount), /None of the given signers match/);
});

test("SEP-10 rejects a challenge with the wrong home domain", async () => {
  const signed = signChallenge(customChallenge(server, "evil.example"), client);
  await assert.rejects(async () => verifyChallenge(signed, noAccount));
});

test("SEP-10 rejects a challenge with the wrong web authentication domain", async () => {
  const signed = signChallenge(customChallenge(server, homeDomain, "other.example"), client);
  await assert.rejects(async () => verifyChallenge(signed, noAccount));
});

test("SEP-10 rejects a challenge built by an unknown server signer", async () => {
  const signed = signChallenge(customChallenge(other), client);
  await assert.rejects(async () => verifyChallenge(signed, noAccount));
});

test("SEP-10 rejects malformed challenge XDR", async () => {
  await assert.rejects(async () => verifyChallenge("not xdr", noAccount));
});

test("a master key with weight 0 on an existing account is refused (400)", async () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), client);
  const lookup = async () =>
    mockAccountEntry({
      accountId: client.publicKey(),
      masterWeight: 0,
      mediumThreshold: 1,
    });

  await assert.rejects(
    async () => verifyChallenge(signed, lookup),
    /do not meet threshold/
  );
});

test("an existing account signed by enough non-master signers is accepted", async () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), other);
  const lookup = async () =>
    mockAccountEntry({
      accountId: client.publicKey(),
      masterWeight: 0,
      mediumThreshold: 1,
      signers: [{ publicKey: other.publicKey(), weight: 1 }],
    });

  const res = await verifyChallenge(signed, lookup);
  assert.deepEqual(res, { account: client.publicKey() });
});

test("a non-existent account signed by its master key is still accepted", async () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), client);
  const res = await verifyChallenge(signed, async () => null);
  assert.deepEqual(res, { account: client.publicKey() });
});

test("RPC lookup failure gives 503", async () => {
  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), client);
  const failingLookup = async () => {
    throw new Error("RPC network timeout");
  };

  await assert.rejects(
    async () => verifyChallenge(signed, failingLookup),
    (err: any) => err instanceof HttpError && err.statusCode === 503
  );
});

test("POST /auth returns 503 on RPC failure and 400 on revoked key", async () => {
  const failingLookup = async () => {
    throw new Error("RPC network timeout");
  };
  const app503 = Fastify();
  await authPlugin(app503, { accountLookup: failingLookup });

  const signed = signChallenge(buildChallenge(client.publicKey(), homeDomain), client);

  const res503 = await app503.inject({
    method: "POST",
    url: "/auth",
    payload: { transaction: signed },
  });
  assert.equal(res503.statusCode, 503);
  const body503 = JSON.parse(res503.payload);
  assert.match(body503.error, /Soroban RPC unavailable/);

  // Revoked key returns 400
  const revokedLookup = async () =>
    mockAccountEntry({
      accountId: client.publicKey(),
      masterWeight: 0,
      mediumThreshold: 1,
    });
  const app400 = Fastify();
  await authPlugin(app400, { accountLookup: revokedLookup });

  const res400 = await app400.inject({
    method: "POST",
    url: "/auth",
    payload: { transaction: signed },
  });
  assert.equal(res400.statusCode, 400);
  const body400 = JSON.parse(res400.payload);
  assert.match(body400.error, /do not meet threshold/);
});

test("JWT round-trips the account subject with a one-hour lifetime", () => {
  const payload = verifyJwt(issueJwt(client.publicKey())) as {
    sub: string;
    iat: number;
    exp: number;
  };
  assert.equal(payload.sub, client.publicKey());
  assert.equal(payload.exp - payload.iat, 3600);
});

test("JWT verification rejects an already-expired signed token", () => {
  const expired = jwt.sign({ sub: client.publicKey() }, jwtSecret, { expiresIn: -10 });
  assert.throws(() => verifyJwt(expired), /jwt expired/);
});

test("JWT verification rejects a payload modified without re-signing", () => {
  const token = issueJwt(client.publicKey());
  const [header, body, signature] = token.split(".");
  assert.ok(header && body && signature);
  const forgedPayload = { ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), sub: other.publicKey() };
  const tampered = [
    header,
    Buffer.from(JSON.stringify(forgedPayload)).toString("base64url"),
    signature,
  ].join(".");
  assert.throws(() => verifyJwt(tampered), /invalid signature/);
});

test("JWT verification rejects a token signed with a different secret", () => {
  const foreign = jwt.sign(
    { sub: client.publicKey() },
    "b".repeat(32),
    { expiresIn: "1h" },
  );
  assert.throws(() => verifyJwt(foreign), /invalid signature/);
});
