import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, xdr, Address } from "@stellar/stellar-sdk";

// Mock env before importing sep45
const keeper = Keypair.random();
const server = Keypair.random();
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

const { buildSep45Challenge, verifySep45Challenge, issueContractJwt } = await import("./sep45.js");

const dummyContractAddress = StrKey.encodeContract(Buffer.alloc(32));

test("SEP-45 Contract Account Authentication - builds a challenge with client contract and valid expiration", () => {
  const { challenge, payload } = buildSep45Challenge(dummyContractAddress, homeDomain);
  assert.equal(challenge.client_contract, dummyContractAddress);
  assert.equal(challenge.home_domain, homeDomain);
  assert.ok(challenge.expires_at > challenge.issued_at);
  assert.ok(typeof payload === "string");
});

test("SEP-45 Contract Account Authentication - rejects non-contract addresses on challenge creation", () => {
  const gAccount = Keypair.random().publicKey();
  assert.throws(() => buildSep45Challenge(gAccount, homeDomain), {
    message: /valid C\.\.\. contract address/,
  });
});

test("SEP-45 Contract Account Authentication - verifies valid authorization entry for contract account", () => {
  const { payload } = buildSep45Challenge(dummyContractAddress, homeDomain);

  // Construct mock SorobanAuthorizationEntry with address credentials
  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: Address.fromString(dummyContractAddress).toScAddress(),
      nonce: 0n,
      signatureExpirationLedger: 1000000,
      signature: xdr.ScVal.scvVoid(),
    })
  );

  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(dummyContractAddress).toScAddress(),
        functionName: "auth",
        args: [],
      })
    ),
    subInvocations: [],
  });

  const entry = new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation,
  });

  const authXdr = entry.toXDR("base64");
  const verified = verifySep45Challenge(payload, authXdr);
  assert.equal(verified.account, dummyContractAddress);

  const token = issueContractJwt(verified.account);
  assert.ok(typeof token === "string");
});

test("SEP-45 Contract Account Authentication - rejects authorization entry with mismatched contract address", () => {
  const { payload } = buildSep45Challenge(dummyContractAddress, homeDomain);
  const otherBuf = Buffer.alloc(32);
  otherBuf[31] = 1;
  const otherContract = StrKey.encodeContract(otherBuf);

  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: Address.fromString(otherContract).toScAddress(),
      nonce: 0n,
      signatureExpirationLedger: 1000000,
      signature: xdr.ScVal.scvVoid(),
    })
  );

  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(otherContract).toScAddress(),
        functionName: "auth",
        args: [],
      })
    ),
    subInvocations: [],
  });

  const entry = new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation,
  });

  const authXdr = entry.toXDR("base64");
  assert.throws(() => verifySep45Challenge(payload, authXdr), {
    message: /authorization entry is for/,
  });
});
