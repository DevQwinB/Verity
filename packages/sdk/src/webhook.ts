import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookOptions {
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  toleranceS?: number;
  now?: number; // timestamp in seconds, defaults to Date.now() / 1000
}

export interface WebhookMessage<T = unknown> {
  id: string;
  event: string;
  data: T;
  created_at: string;
}

/**
 * Cryptographically verifies an incoming webhook request from Verity.
 * Checks HMAC-SHA256 signature and timestamp tolerance window.
 * Returns the parsed webhook message payload.
 */
export function verifyWebhook<T = unknown>(opts: VerifyWebhookOptions): WebhookMessage<T> {
  const secret = opts.secret;
  if (!secret || secret.length < 8) {
    throw new Error("Webhook secret must be at least 8 characters");
  }

  const getHeader = (name: string): string | undefined => {
    const val = opts.headers[name] ?? opts.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  const provided = getHeader("x-verity-signature");
  const timestamp = getHeader("x-verity-timestamp");
  const deliveryId = getHeader("x-verity-delivery");

  if (!provided || typeof provided !== "string") {
    throw new Error("Missing or invalid x-verity-signature header");
  }
  if (!timestamp || typeof timestamp !== "string") {
    throw new Error("Missing or invalid x-verity-timestamp header");
  }
  if (!deliveryId || typeof deliveryId !== "string") {
    throw new Error("Missing or invalid x-verity-delivery header");
  }

  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) {
    throw new Error("x-verity-timestamp is not a valid number");
  }

  const nowSec = opts.now ?? Date.now() / 1000;
  const tolerance = opts.toleranceS ?? 300;
  const age = Math.abs(nowSec - timestampNum);
  if (age > tolerance) {
    throw new Error(`Webhook timestamp expired: age ${age.toFixed(1)}s exceeds tolerance of ${tolerance}s`);
  }

  const rawBuffer = Buffer.isBuffer(opts.rawBody)
    ? opts.rawBody
    : Buffer.from(opts.rawBody, "utf8");

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`)
    .update(rawBuffer)
    .digest();

  if (
    provided.length !== 64 ||
    !/^[0-9a-f]{64}$/i.test(provided) ||
    !timingSafeEqual(Buffer.from(provided, "hex"), expected)
  ) {
    throw new Error("Invalid webhook signature");
  }

  return JSON.parse(rawBuffer.toString("utf8")) as WebhookMessage<T>;
}
