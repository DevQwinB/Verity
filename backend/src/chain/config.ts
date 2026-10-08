import type { ConfigRecord } from "escrow-gate";
import { escrowGateAsKeeper } from "./clients.js";

const TTL_MS = 60_000;
let cached: { at: number; config: ConfigRecord } | null = null;

/** EscrowGate's live configuration. It changes only through an admin
 * update_config transaction, so a short cache spares an RPC round-trip on
 * every assignment and every page that shows a bond floor. */
export async function getGateConfig(): Promise<ConfigRecord> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.config;
  const config = (await escrowGateAsKeeper.get_config()).result;
  if (!config) throw new Error("EscrowGate returned no configuration");
  cached = { at: Date.now(), config };
  return config;
}
