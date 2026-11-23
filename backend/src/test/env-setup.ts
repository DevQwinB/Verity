import { Keypair, StrKey } from "@stellar/stellar-sdk";

const dummyContractId = StrKey.encodeContract(Buffer.alloc(32));
const defaultEnv: Record<string, string> = {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: dummyContractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: dummyContractId,
  BOND_ASSET_CONTRACT_ID: dummyContractId,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
};

for (const [key, val] of Object.entries(defaultEnv)) {
  if (!process.env[key]) {
    process.env[key] = val;
  }
}
