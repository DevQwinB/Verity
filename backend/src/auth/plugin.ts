import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../http-error.js";
import { buildChallenge, issueJwt, verifyChallenge, verifyJwt } from "./sep10.js";
import { buildSep45Challenge, issueContractJwt, verifySep45Challenge } from "./sep45.js";

declare module "fastify" {
  interface FastifyRequest {
    stellarAccount?: string;
  }
}

export async function authPlugin(app: FastifyInstance) {
  app.get("/auth", async (req) => {
    const query = z
      .object({
        account: z
          .string()
          .min(1)
          .refine(StrKey.isValidEd25519PublicKey, "account must be a valid Stellar public key"),
        home_domain: z.string().optional(),
      })
      .parse(req.query);
    if (query.home_domain !== undefined && query.home_domain !== env.HOME_DOMAIN) {
      throw new HttpError(400, `home_domain must be ${env.HOME_DOMAIN}`);
    }
    const transaction = buildChallenge(query.account, env.HOME_DOMAIN);
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

  // SEP-45 contract accounts authentication
  app.get("/auth/contract", async (req) => {
    const query = z
      .object({
        account: z
          .string()
          .min(1)
          .refine(StrKey.isValidContract, "account must be a valid C... contract address"),
        home_domain: z.string().optional(),
      })
      .parse(req.query);
    if (query.home_domain !== undefined && query.home_domain !== env.HOME_DOMAIN) {
      throw new HttpError(400, `home_domain must be ${env.HOME_DOMAIN}`);
    }
    const { challenge, payload } = buildSep45Challenge(query.account, env.HOME_DOMAIN);
    return { challenge, payload, network_passphrase: env.NETWORK_PASSPHRASE };
  });

  app.post("/auth/contract", async (req, reply) => {
    const body = z
      .object({
        payload: z.string().min(1),
        authorization_entry: z.string().min(1),
      })
      .parse(req.body);
    try {
      const { account } = verifySep45Challenge(body.payload, body.authorization_entry);
      const token = issueContractJwt(account);
      return { token };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid contract authorization" };
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
