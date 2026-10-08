import type { FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { sep10SigningKey } from "./auth/sep10.js";

/**
 * SEP-1 file advertising the SEP-10 endpoint and its signing key. Served by
 * the backend because WEB_AUTH_DOMAIN points at it; a deployment whose home
 * domain is a different host should serve the same content from there.
 */
export async function wellKnownPlugin(app: FastifyInstance) {
  app.get("/.well-known/stellar.toml", async (_req, reply) => {
    reply.type("text/plain");
    return [
      `NETWORK_PASSPHRASE="${env.NETWORK_PASSPHRASE}"`,
      `WEB_AUTH_ENDPOINT="${env.PUBLIC_SCHEME}://${env.WEB_AUTH_DOMAIN}/auth"`,
      `SIGNING_KEY="${sep10SigningKey}"`,
    ].join("\n");
  });
}
