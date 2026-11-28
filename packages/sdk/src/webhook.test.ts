import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "./webhook.js";

const SECRET = "secret-12345678";

function createValidHeaders(
  rawBody: Buffer | string,
  secret: string = SECRET,
  timestampOffset: number = 0
): { headers: Record<string, string>; deliveryId: string; timestamp: string; rawBody: string } {
  const deliveryId = "deliv-12345678-abcd";
  const now = Math.floor(Date.now() / 1000) + timestampOffset;
  const timestamp = String(now);
  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(bodyStr, "utf8"))
    .digest("hex");

  return {
    headers: {
      "x-verity-delivery": deliveryId,
      "x-verity-timestamp": timestamp,
      "x-verity-signature": sig,
    },
    deliveryId,
    timestamp,
    rawBody: bodyStr,
  };
}

test("verifyWebhook successfully verifies valid webhook with string body", () => {
  const payload = {
    id: "deliv-1",
    event: "submission.verified",
    data: { submission_id: "sub-123", status: "verified" },
    created_at: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  const { headers } = createValidHeaders(rawBody);

  const result = verifyWebhook({
    rawBody,
    headers,
    secret: SECRET,
  });

  assert.deepEqual(result, payload);
});

test("verifyWebhook successfully verifies valid webhook with Buffer body", () => {
  const payload = {
    id: "deliv-2",
    event: "submission.verified",
    data: { submission_id: "sub-456" },
    created_at: new Date().toISOString(),
  };
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const { headers } = createValidHeaders(rawBody);

  const result = verifyWebhook({
    rawBody,
    headers,
    secret: SECRET,
  });

  assert.deepEqual(result, payload);
});

test("verifyWebhook works with custom now timestamp", () => {
  const payload = { id: "1", event: "test", data: {}, created_at: "" };
  const rawBody = JSON.stringify(payload);
  const baseTime = 1700000000;
  const deliveryId = "deliv-123";
  const sig = createHmac("sha256", SECRET)
    .update(`${baseTime}.${deliveryId}.`)
    .update(rawBody)
    .digest("hex");

  const result = verifyWebhook({
    rawBody,
    headers: {
      "x-verity-delivery": deliveryId,
      "x-verity-timestamp": String(baseTime),
      "x-verity-signature": sig,
    },
    secret: SECRET,
    now: baseTime + 10,
  });

  assert.deepEqual(result, payload);
});

test("verifyWebhook throws if secret is under 8 characters", () => {
  assert.throws(
    () =>
      verifyWebhook({
        rawBody: "{}",
        headers: {},
        secret: "short",
      }),
    /secret must be at least 8 characters/
  );
});

test("verifyWebhook throws if signature header is missing", () => {
  assert.throws(
    () =>
      verifyWebhook({
        rawBody: "{}",
        headers: { "x-verity-delivery": "1", "x-verity-timestamp": "123" },
        secret: SECRET,
      }),
    /Missing or invalid x-verity-signature/
  );
});

test("verifyWebhook throws if timestamp header is missing or non-numeric", () => {
  assert.throws(
    () =>
      verifyWebhook({
        rawBody: "{}",
        headers: { "x-verity-signature": "a".repeat(64), "x-verity-delivery": "1" },
        secret: SECRET,
      }),
    /Missing or invalid x-verity-timestamp/
  );

  assert.throws(
    () =>
      verifyWebhook({
        rawBody: "{}",
        headers: {
          "x-verity-signature": "a".repeat(64),
          "x-verity-delivery": "1",
          "x-verity-timestamp": "not-a-number",
        },
        secret: SECRET,
      }),
    /not a valid number/
  );
});

test("verifyWebhook throws if delivery header is missing", () => {
  assert.throws(
    () =>
      verifyWebhook({
        rawBody: "{}",
        headers: { "x-verity-signature": "a".repeat(64), "x-verity-timestamp": "12345" },
        secret: SECRET,
      }),
    /Missing or invalid x-verity-delivery/
  );
});

test("verifyWebhook throws if timestamp is expired beyond tolerance", () => {
  const rawBody = "{}";
  const { headers } = createValidHeaders(rawBody, SECRET, -350); // 350s old
  assert.throws(
    () =>
      verifyWebhook({
        rawBody,
        headers,
        secret: SECRET,
        toleranceS: 300,
      }),
    /expired: age .* exceeds tolerance/
  );
});

test("verifyWebhook throws if timestamp is too far in future beyond tolerance", () => {
  const rawBody = "{}";
  const { headers } = createValidHeaders(rawBody, SECRET, 350); // 350s into future
  assert.throws(
    () =>
      verifyWebhook({
        rawBody,
        headers,
        secret: SECRET,
        toleranceS: 300,
      }),
    /expired: age .* exceeds tolerance/
  );
});

test("verifyWebhook throws on invalid hex signature", () => {
  const rawBody = "{}";
  const { headers } = createValidHeaders(rawBody);
  headers["x-verity-signature"] = "not-valid-hex-at-all".padStart(64, "0");
  assert.throws(
    () =>
      verifyWebhook({
        rawBody,
        headers,
        secret: SECRET,
      }),
    /Invalid webhook signature/
  );
});

test("verifyWebhook throws on signature mismatch", () => {
  const rawBody = "{}";
  const { headers } = createValidHeaders(rawBody, "different-secret-12345");
  assert.throws(
    () =>
      verifyWebhook({
        rawBody,
        headers,
        secret: SECRET,
      }),
    /Invalid webhook signature/
  );
});
