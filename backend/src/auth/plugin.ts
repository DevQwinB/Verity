import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { buildChallenge, issueJwt, verifyChallenge, verifyJwt } from "./sep10.js";

declare module "fastify" {
  interface FastifyRequest {
    stellarAccount?: string;
  }
}

export async function authPlugin(app: FastifyInstance) {
  app.get("/auth", async (req, reply) => {
    const query = z
      .object({ account: z.string().min(1), home_domain: z.string().optional() })
      .parse(req.query);
    const transaction = buildChallenge(query.account, query.home_domain ?? env.HOME_DOMAIN);
    return { transaction, network_passphrase: env.NETWORK_PASSPHRASE };
  });

  app.post("/auth", async (req, reply) => {
    const body = z.object({ transaction: z.string().min(1) }).parse(req.body);
    try {
      const { account } = verifyChallenge(body.transaction);
      const token = issueJwt(account);
      return { token };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid challenge" };
    }
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing bearer token" });
    return;
  }
  try {
    const { sub } = verifyJwt(header.slice("Bearer ".length));
    req.stellarAccount = sub;
  } catch {
    reply.code(401).send({ error: "invalid or expired token" });
  }
}
