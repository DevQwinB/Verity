import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { sql } from "kysely";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { db } from "./db.js";
import { server } from "./chain/rpc.js";
import { contractErrorName } from "./chain/actions.js";
import { HttpError } from "./http-error.js";
import { authPlugin } from "./auth/plugin.js";
import { verifyJwt } from "./auth/sep10.js";
import { wellKnownPlugin } from "./wellKnown.js";
import { submissionsRoutes } from "./modules/submissions/routes.js";
import { reexecutorsRoutes } from "./modules/reexecutors/routes.js";
import { challengesRoutes } from "./modules/challenges/routes.js";
import { taxonomyRoutes } from "./modules/taxonomy/routes.js";
import { reportsRoutes } from "./modules/reports/routes.js";
import { artifactsRoutes } from "./modules/artifacts/routes.js";
import { marketplacesRoutes } from "./modules/marketplaces/routes.js";
import { configRoutes } from "./modules/config/routes.js";

/** More than this many ledgers (~5s each) behind the chain tip and the
 * indexer is not keeping up: verdicts on the dashboard are stale. */
const MAX_INDEXER_LAG_LEDGERS = 240;

async function check(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

export function buildApp() {
  const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY, bodyLimit: 1_048_576 });
  app.register(cookie);
  app.register(helmet);
  // One bucket per signed-in account, otherwise per client address — the
  // dashboard's server reads all arrive from one address, so it forwards the
  // browser's (see TRUST_PROXY).
  app.register(rateLimit, {
    max: env.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    allowList: (req) => req.url.startsWith("/health"),
    keyGenerator: (req) => {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        try {
          return `account:${verifyJwt(header.slice("Bearer ".length)).sub}`;
        } catch {
          // fall through: an invalid token is rate limited by address
        }
      }
      return `ip:${req.ip}`;
    },
  });

  // Bad input and contract-level rejections are the caller's problem, not a
  // server fault: surface them as 4xx with the real reason (the contract's
  // own error name) instead of an opaque 500. Anything unexpected is logged
  // in full and answered with nothing that describes this server's insides.
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const contractError = contractErrorName(err);
    if (contractError) {
      return reply.code(422).send({ error: `EscrowGate rejected the transaction: ${contractError}`, contract_error: contractError });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ error: err instanceof Error ? err.message : String(err) });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  // Liveness: the process is up. Nothing else is implied.
  app.get("/health/live", async () => ({ ok: true }));

  // Readiness: can this instance actually serve true data right now?
  app.get("/health", async (_req, reply) => {
    const database = await check(() => sql`select 1`.execute(db));
    let latestLedger: number | null = null;
    const rpc = await check(async () => {
      latestLedger = (await server.getLatestLedger()).sequence;
    });
    let indexerLag: number | null = null;
    if (database && latestLedger !== null) {
      const cursor = await db
        .selectFrom("chain_cursor")
        .select("last_ledger")
        .where("contract_id", "=", env.ESCROW_GATE_CONTRACT_ID)
        .executeTakeFirst();
      // No cursor yet means the indexer has not run its first poll.
      if (cursor) indexerLag = Math.max(0, latestLedger - Number(cursor.last_ledger));
    }
    const indexer = indexerLag === null || indexerLag <= MAX_INDEXER_LAG_LEDGERS;
    const ok = database && rpc && indexer;
    reply.code(ok ? 200 : 503);
    return {
      ok,
      deployment: env.DEPLOYMENT_NAME,
      network_passphrase: env.NETWORK_PASSPHRASE,
      escrow_gate_contract_id: env.ESCROW_GATE_CONTRACT_ID,
      workers: env.RUN_WORKERS,
      checks: { database, rpc, indexer, indexer_lag_ledgers: indexerLag },
    };
  });

  app.register(wellKnownPlugin);
  app.register(authPlugin);
  app.register(configRoutes);
  app.register(marketplacesRoutes);
  app.register(submissionsRoutes);
  app.register(reexecutorsRoutes);
  app.register(challengesRoutes);
  app.register(taxonomyRoutes);
  app.register(reportsRoutes);
  app.register(artifactsRoutes);
  return app;
}
