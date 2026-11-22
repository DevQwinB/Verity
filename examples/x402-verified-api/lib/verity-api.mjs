import { TransactionBuilder } from "@stellar/stellar-sdk";

/** Thin client for the Verity backend API, mirroring backend/src/smoke/run.ts:
 * SEP-10 login, artifact upload, build → sign → relay a submission, poll to
 * a terminal verdict, fetch the attestation. */

export async function call(base, path, { token, body, method } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/** SEP-10: fetch the challenge, sign it with the account key, exchange for a JWT. */
export async function login(base, keypair, networkPassphrase) {
  const { transaction } = await call(base, `/auth?account=${keypair.publicKey()}`);
  const tx = TransactionBuilder.fromXDR(transaction, networkPassphrase);
  tx.sign(keypair);
  const { token } = await call(base, "/auth", { body: { transaction: tx.toXDR() } });
  return token;
}

export async function uploadArtifact(base, token, content, contentType) {
  return call(base, "/v1/artifacts", {
    token,
    body: { content_base64: Buffer.from(content, "utf8").toString("base64"), content_type: contentType },
  });
}

/** Uploads input/function/output and builds + relays the bonded submit().
 * `escrowRef` is the x402 settlement tx hash (see lib/payment-ref.mjs). */
export async function submitBonded(base, agent, { escrowRef, taskType, functionSource, input, claimedOutput, escrowValueStroops, bondStroops, idempotencyKey }) {
  const inputArt = await uploadArtifact(base, agent.token, input, "application/json");
  const outputArt = await uploadArtifact(base, agent.token, claimedOutput, "application/json");
  const fnArt = functionSource === null ? null : await uploadArtifact(base, agent.token, functionSource, "text/javascript");
  const created = await call(base, "/v1/submissions", {
    token: agent.token,
    body: {
      escrow_ref: escrowRef,
      task_type: taskType,
      input_hash: inputArt.content_hash,
      input_ref: inputArt.storage_ref,
      claimed_output_hash: outputArt.content_hash,
      claimed_output_ref: outputArt.storage_ref,
      function_hash: fnArt?.content_hash,
      function_ref: fnArt?.storage_ref,
      escrow_value: escrowValueStroops,
      bond_amount: bondStroops,
      idempotency_key: idempotencyKey,
    },
  });
  if (created.unsigned_transaction_xdr === null) {
    return { id: created.submission.id, chainId: created.submission.chain_submission_id ?? null, alreadyOnChain: true };
  }
  const tx = TransactionBuilder.fromXDR(created.unsigned_transaction_xdr, created.network_passphrase);
  tx.sign(agent.keypair);
  const relayed = await call(base, `/v1/submissions/${created.submission.id}/relay`, {
    token: agent.token,
    body: { signed_transaction_xdr: tx.toXDR() },
  });
  return { id: created.submission.id, chainId: relayed.submission.chain_submission_id, txHash: relayed.tx_hash, alreadyOnChain: false };
}

export const TERMINAL_STATUSES = ["verified", "slashed", "expired_unverified"];

export async function getSubmission(base, id) {
  return call(base, `/v1/submissions/${encodeURIComponent(id)}`);
}

/** Polls until the submission reaches a terminal verdict. */
export async function waitForVerdict(base, id, { timeoutS = 300, everyMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const d = await getSubmission(base, id);
    if (TERMINAL_STATUSES.includes(d.submission.status)) return d.submission;
    if (Date.now() > deadline) throw new Error(`submission ${id} not terminal after ${timeoutS}s (status ${d.submission.status})`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function getAttestation(base, id) {
  return call(base, `/v1/submissions/${encodeURIComponent(id)}/attestation`);
}
