import Fastify from "fastify";
import cookie from "@fastify/cookie";
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
