async function json<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data as T;
}

export async function fetchChallenge(account: string) {
  const res = await fetch(`/api/auth/challenge?account=${encodeURIComponent(account)}`);
  return json<{ transaction: string; network_passphrase: string }>(res);
}

export async function exchangeChallenge(signedTransactionXdr: string) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: signedTransactionXdr }),
  });
  return json<{ account: string }>(res);
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function getSession() {
  const res = await fetch("/api/session", { cache: "no-store" });
  return json<{ account: string | null }>(res);
}

export interface CreateSubmissionInput {
  escrow_ref: string;
  task_type: "deterministic" | "retrieval" | "unverifiable";
  input_hash: string;
  claimed_output_hash: string;
  input_ref?: string;
  function_hash?: string;
  function_ref?: string;
  claimed_output_ref?: string;
  escrow_value: string;
  bond_amount: string;
  idempotency_key: string;
}

export async function createSubmission(input: CreateSubmissionInput) {
  const res = await fetch("/api/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return json<{
    submission: { id: string };
    unsigned_transaction_xdr: string;
    network_passphrase: string;
  }>(res);
}

export async function relaySubmission(id: string, signedTransactionXdr: string) {
  const res = await fetch(`/api/submissions/${id}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed_transaction_xdr: signedTransactionXdr }),
  });
  return json<{ submission: unknown; tx_hash: string }>(res);
}

export async function openChallenge(submissionId: string, bond: string) {
  const res = await fetch(`/api/submissions/${submissionId}/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bond }),
  });
  return json<{ unsigned_transaction_xdr: string }>(res);
}

export async function relayChallenge(submissionId: string, signedTransactionXdr: string) {
  const res = await fetch(`/api/submissions/${submissionId}/challenge/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed_transaction_xdr: signedTransactionXdr }),
  });
  return json<{ tx_hash: string }>(res);
}

export async function registerReexecutor(stakeAmount: string) {
  const res = await fetch("/api/reexecutors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stake_amount: stakeAmount }),
  });
  return json<{ reexecutor: { id: string }; unsigned_transaction_xdr: string }>(res);
}

export async function relayReexecutorStake(id: string, signedTransactionXdr: string) {
  const res = await fetch(`/api/reexecutors/${id}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed_transaction_xdr: signedTransactionXdr }),
  });
  return json<{ reexecutor: unknown; tx_hash: string }>(res);
}

export async function uploadArtifact(contentBase64: string, contentType?: string) {
  const res = await fetch("/api/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content_base64: contentBase64, content_type: contentType }),
  });
  return json<{ content_hash: string; storage_ref: string; size_bytes: number }>(res);
}
