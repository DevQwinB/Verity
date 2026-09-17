import type { FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { keeperPublicKey } from "./chain/keeper.js";

/**
 * Served here for dev/smoke-test convenience since WEB_AUTH_DOMAIN points at
 * the backend directly. In a real deployment this belongs on the public home
 * domain (frontend/public/.well-known/stellar.toml) per SEP-1/SEP-10.
 */
export async function wellKnownPlugin(app: FastifyInstance) {
  app.get("/.well-known/stellar.toml", async (_req, reply) => {
    reply.type("text/plain");
    return [
      `NETWORK_PASSPHRASE="${env.NETWORK_PASSPHRASE}"`,
      `WEB_AUTH_ENDPOINT="http://${env.WEB_AUTH_DOMAIN}/auth"`,
      `SIGNING_KEY="${keeperPublicKey}"`,
      `[[CURRENCIES]]`,
      `code="VERITY-BOND"`,
      `issuer="${env.BOND_ASSET_CONTRACT_ID}"`,
    ].join("\n");
  });
}
