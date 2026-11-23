import { Keypair } from "@stellar/stellar-sdk";
import { VerityClient, verifyAttestation } from "../src/index.js";

async function main() {
  const apiUrl = process.env.VERITY_API_URL ?? "http://localhost:3001";
  const secretKey = process.env.AGENT_SECRET_KEY;
  const keypair = secretKey ? Keypair.fromSecret(secretKey) : Keypair.random();

  console.log(`Using agent account: ${keypair.publicKey()}`);

  const client = new VerityClient({
    apiUrl,
    signer: keypair,
  });

  console.log("Fetching Verity GateConfig from API...");
  const config = await client.getConfig();
  console.log(`Connected to deployment '${config.deployment}' with contract '${config.escrow_gate_contract_id}'`);

  console.log("Authenticating with Verity via SEP-10 challenge...");
  await client.login();
  console.log("Authentication successful.");

  console.log("Submitting deterministic task...");
  const submission = await client.submit({
    escrowRef: `task-${Date.now()}`,
    taskType: "deterministic",
    input: { value: 21 },
    claimedOutput: { result: 42 },
    functionSource: "export default function handler(input) { return { result: input.value * 2 }; }",
    escrowValue: "10000000",
    bondAmount: "10000000",
  });

  console.log(`Submission created: id=${submission.id}, status=${submission.status}, txHash=${submission.txHash ?? "none"}`);

  console.log("Waiting for re-executor quorum verdict...");
  const verdict = await client.waitForVerdict(submission.id, { timeoutMs: 120_000 });
  console.log(`Verdict reached: ${verdict.status}`);

  console.log("Fetching and verifying attestation...");
  const attestation = await client.getAttestation(submission.id);
  const payload = verifyAttestation(attestation, {
    trustedSigner: attestation.signer, // In production, supply trusted keeper public key
    networkPassphrase: config.network_passphrase,
    escrowGateContractId: config.escrow_gate_contract_id,
    submissionId: submission.id,
  });

  console.log("Attestation verified successfully:", JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error("SDK submit example failed:", err);
  process.exit(1);
});
