import "dotenv/config";
import "./net.js";
import { z } from "zod";

const schema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),
  NETWORK_PASSPHRASE: z.string().min(1),
  ESCROW_GATE_CONTRACT_ID: z.string().min(1),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: z.string().min(1),
  BOND_ASSET_CONTRACT_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  KEEPER_SECRET_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  WEB_AUTH_DOMAIN: z.string().min(1),
  HOME_DOMAIN: z.string().min(1),
  PORT: z.coerce.number().default(3001),
  ARTIFACT_STORAGE_DIR: z.string().default("./.artifacts"),
  // Share of a wrong-side re-executor's stake the keeper slashes after a
  // finalized verdict proves their attestation wrong. The contract only
  // bounds this by the stake itself, so the policy lives here.
  REEXECUTOR_SLASH_BPS: z.coerce.number().int().min(0).max(10000).default(1000),
});

export const env = schema.parse(process.env);
