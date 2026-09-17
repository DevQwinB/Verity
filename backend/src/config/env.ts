import "dotenv/config";
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
});

export const env = schema.parse(process.env);
