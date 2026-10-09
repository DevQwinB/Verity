import "dotenv/config";
import "./net.js";
import { z } from "zod";

const flag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((v) => v === "true");

const schema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  NETWORK_PASSPHRASE: z.string().min(1),
  ESCROW_GATE_CONTRACT_ID: z.string().min(1),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: z.string().min(1),
  BOND_ASSET_CONTRACT_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  KEEPER_SECRET_KEY: z.string().min(1),
  // Signs SEP-10 challenges. Defaults to the keeper key; give it its own so
  // the key that moves funds is not also the one answering every login.
  SEP10_SIGNING_SECRET: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)"),
  // Host (and port) users reach the auth endpoint on, without a scheme.
  WEB_AUTH_DOMAIN: z.string().min(1),
  HOME_DOMAIN: z.string().min(1),
  // Scheme the public sees: "https" behind any real reverse proxy.
  PUBLIC_SCHEME: z.enum(["http", "https"]).default("http"),
  PORT: z.coerce.number().default(3001),
  // Shown by /health so tooling can tell which deployment it is talking to.
  DEPLOYMENT_NAME: z.string().default("testnet"),
  ARTIFACT_STORAGE_DIR: z.string().default("./.artifacts"),
  ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().default(262_144),

  // The indexer and keeper share one account sequence and one chain cursor,
  // so exactly one process may run them. Extra API-only instances set false.
  RUN_WORKERS: flag("true"),
  // Set true only behind a reverse proxy you control, so the client address
  // used for rate limiting comes from X-Forwarded-For.
  TRUST_PROXY: flag("false"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),

  // A re-executor counts as online if its worker polled for work this recently.
  REEXECUTOR_LIVENESS_S: z.coerce.number().int().positive().default(60),
  // Extra re-executors assigned beyond quorum, so one slow or offline worker
  // does not cost a submission its consensus.
  REPLAY_OVERASSIGN: z.coerce.number().int().min(0).default(1),
  // An assignment unanswered for this long no longer counts toward quorum
  // and another re-executor is asked.
  REPLAY_REASSIGN_AFTER_S: z.coerce.number().int().positive().default(120),
  // Unsigned submission drafts older than this are deleted. Must outlast the
  // validity of the transaction built for them.
  DRAFT_TTL_S: z.coerce.number().int().positive().default(3600),
});

export const env = schema.parse(process.env);
