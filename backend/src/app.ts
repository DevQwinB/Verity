import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { contractErrorName } from "./chain/actions.js";
import { authPlugin } from "./auth/plugin.js";
import { wellKnownPlugin } from "./wellKnown.js";
import { submissionsRoutes } from "./modules/submissions/routes.js";
import { reexecutorsRoutes } from "./modules/reexecutors/routes.js";
import { challengesRoutes } from "./modules/challenges/routes.js";
import { taxonomyRoutes } from "./modules/taxonomy/routes.js";
import { reportsRoutes } from "./modules/reports/routes.js";
import { artifactsRoutes } from "./modules/artifacts/routes.js";
import { marketplacesRoutes } from "./modules/marketplaces/routes.js";

export function buildApp() {
  const app = Fastify({ logger: true });
  app.register(cookie);

  // Bad input and contract-level rejections are the caller's problem, not a
  // server fault: surface them as 4xx with the real reason (the contract's
  // own error name) instead of an opaque 500.
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    const contractError = contractErrorName(err);
    if (contractError) {
      return reply.code(422).send({ error: `EscrowGate rejected the transaction: ${contractError}`, contract_error: contractError });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: message });
    req.log.error(err);
    return reply.code(500).send({ error: message });
  });
  app.get("/health", async () => ({ ok: true }));
  app.register(wellKnownPlugin);
  app.register(authPlugin);
  app.register(marketplacesRoutes);
  app.register(submissionsRoutes);
  app.register(reexecutorsRoutes);
  app.register(challengesRoutes);
  app.register(taxonomyRoutes);
  app.register(reportsRoutes);
  app.register(artifactsRoutes);
  return app;
}
