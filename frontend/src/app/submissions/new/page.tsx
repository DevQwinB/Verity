"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../components/wallet-provider";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { uploadArtifact, createSubmission, relaySubmission } from "../../../lib/client-api";
import { signXdr } from "../../../lib/wallet";
import { NETWORK_PASSPHRASE } from "../../../lib/config";
import type { TaskType } from "../../../lib/types";

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

type Step = "idle" | "uploading" | "building" | "signing" | "relaying" | "done" | "error";

export default function NewSubmissionPage() {
  const router = useRouter();
  const { account, connecting, login } = useWallet();

  const [escrowRef, setEscrowRef] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("deterministic");
  const [escrowValueXlm, setEscrowValueXlm] = useState("100");
  const [bondXlm, setBondXlm] = useState("5");
  const [inputContent, setInputContent] = useState("");
  const [functionContent, setFunctionContent] = useState("");
  const [outputContent, setOutputContent] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);

  function toStroops(xlm: string) {
    return String(BigInt(Math.round(Number(xlm) * 10_000_000)));
  }

  async function handleSubmit() {
    if (!account) return;
    setError(null);
    try {
      setStep("uploading");
      const input = await uploadArtifact(textToBase64(inputContent), "text/plain");
      const output = await uploadArtifact(textToBase64(outputContent), "text/plain");
      const fn =
        taskType === "deterministic" && functionContent
          ? await uploadArtifact(textToBase64(functionContent), "text/plain")
          : null;

      setStep("building");
      const { submission, unsigned_transaction_xdr } = await createSubmission({
        escrow_ref: escrowRef,
        task_type: taskType,
        input_hash: input.content_hash,
        input_ref: input.storage_ref,
        claimed_output_hash: output.content_hash,
        claimed_output_ref: output.storage_ref,
        function_hash: fn?.content_hash,
        function_ref: fn?.storage_ref,
        escrow_value: toStroops(escrowValueXlm),
        bond_amount: toStroops(bondXlm),
        idempotency_key: crypto.randomUUID(),
      });
      setSubmissionId(submission.id);

      setStep("signing");
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: account,
      });

      setStep("relaying");
      await relaySubmission(submission.id, signed);
      setStep("done");
      router.push(`/submissions/${submission.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
      setStep("error");
    }
  }

  const busy = step !== "idle" && step !== "error" && step !== "done";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New submission</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Submits a real, signed transaction to EscrowGate on Stellar testnet. Deterministic tasks
          are replayed by real re-executors; retrieval tasks are statistically spot-checked.
        </p>
      </div>

      <Card>
        <CardHeader>
          <span className="font-medium">Task details</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Escrow reference">
            <input
              value={escrowRef}
              onChange={(e) => setEscrowRef(e.target.value)}
              placeholder="bounty-platform-order-id"
              className={inputClass}
            />
          </Field>

          <Field label="Task type">
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
              className={inputClass}
            >
              <option value="deterministic">Deterministic (replay-verified)</option>
              <option value="retrieval">Retrieval (spot-checked)</option>
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Escrow value (XLM)">
              <input
                type="number"
                value={escrowValueXlm}
                onChange={(e) => setEscrowValueXlm(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Agent bond (XLM)">
              <input
                type="number"
                value={bondXlm}
                onChange={(e) => setBondXlm(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span className="font-medium">Content-addressed artifacts</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Input">
            <textarea
              value={inputContent}
              onChange={(e) => setInputContent(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </Field>
          {taskType === "deterministic" && (
            <Field label="Deterministic function (script)" helper="Hashed and stored; re-executors run this exact artifact.">
              <textarea
                value={functionContent}
                onChange={(e) => setFunctionContent(e.target.value)}
                rows={4}
                className={cnMono}
              />
            </Field>
          )}
          <Field label="Claimed output">
            <textarea
              value={outputContent}
              onChange={(e) => setOutputContent(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </Field>
        </CardBody>
      </Card>

      {error && <p className="text-sm text-status-slashed">{error}</p>}

      {account ? (
        <Button onClick={handleSubmit} disabled={busy || !escrowRef || !inputContent || !outputContent}>
          {step === "uploading"
            ? "Uploading artifacts..."
            : step === "building"
              ? "Building transaction..."
              : step === "signing"
                ? "Awaiting signature in Freighter..."
                : step === "relaying"
                  ? "Submitting to testnet..."
                  : "Submit for verification"}
        </Button>
      ) : (
        <Button onClick={login} disabled={connecting}>
          {connecting ? "Connecting..." : "Connect wallet to continue"}
        </Button>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent";
const cnMono = `${inputClass} font-mono text-xs`;

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm text-text-secondary">{label}</label>
      {children}
      {helper && <p className="text-xs text-text-tertiary">{helper}</p>}
    </div>
  );
}
