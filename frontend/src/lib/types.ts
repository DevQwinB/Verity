export type TaskType = "deterministic" | "retrieval" | "unverifiable";
export type SubmissionStatus =
  | "pending"
  | "verified"
  | "disputed"
  | "slashed"
  | "expired_unverified";

export interface Submission {
  id: string;
  escrow_ref: string;
  marketplace_id: string;
  agent_id: string;
  task_type: TaskType;
  input_hash: string;
  input_ref: string | null;
  function_hash: string | null;
  function_ref: string | null;
  claimed_output_hash: string;
  claimed_output_ref: string | null;
  bond_amount: string;
  bond_asset: string;
  submitted_at: string;
  challenge_window_s: number;
  status: SubmissionStatus;
  chain_submission_id: string | null;
  chain_tx_hash: string | null;
  idempotency_key: string | null;
  finalize_attempted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ReplayStatus = "assigned" | "submitted" | "confirmed_onchain";

export interface Replay {
  id: string;
  submission_id: string;
  reexecutor_id: string;
  status: ReplayStatus;
  assignment_seed: string | null;
  replay_output_hash: string | null;
  match: boolean | null;
  latency_ms: number | null;
  cost: string | null;
  tx_hash: string | null;
  assigned_at: string;
  executed_at: string | null;
}

export type SpotCheckResult = "match" | "mismatch" | "inconclusive";

export interface SpotCheck {
  id: string;
  submission_id: string;
  reexecutor_id: string;
  sampled_at: string;
  result: SpotCheckResult | null;
  evidence: unknown;
}

export type ChallengeResolution = "upheld" | "rejected";
export type ChallengeResolutionMethod =
  | "reexecution_consensus"
  | "zk_proof"
  | "manual_review";

export interface Challenge {
  id: string;
  submission_id: string;
  challenger_account: string;
  challenger_bond: string;
  opened_at: string;
  resolved_at: string | null;
  resolution: ChallengeResolution | null;
  resolution_method: ChallengeResolutionMethod | null;
  chain_tx_hash: string | null;
}

export interface ChallengeListItem extends Challenge {
  escrow_ref: string;
  task_type: TaskType;
  status: SubmissionStatus;
  chain_submission_id: string | null;
}

export interface Reexecutor {
  id: string;
  stellar_account: string;
  stake_amount: string;
  stake_asset: string;
  reputation_score: string;
  active: boolean;
  slashed_count: number;
  chain_stake_tx_hash: string | null;
  last_seen_at: string | null;
  joined_at: string;
}

export interface SlashingEvent {
  id: string;
  reexecutor_id: string;
  submission_id: string | null;
  amount: string;
  reason: string;
  tx_hash: string | null;
  created_at: string;
}

export interface SubmissionDetail {
  submission: Submission;
  replays: Replay[];
  spot_checks: SpotCheck[];
  challenge: Challenge | null;
}

export interface ProofStatus {
  available: boolean;
  phase?: number;
  reason?: string;
}

export interface TaxonomyEntry {
  type: TaskType;
  verification_method: string;
  description: string;
}

export interface Taxonomy {
  version: number;
  task_types: TaxonomyEntry[];
}

export interface VerificationRatesReport {
  by_marketplace_task_status: Array<{
    marketplace_id: string;
    task_type: TaskType;
    status: SubmissionStatus;
    count: string;
  }>;
  slashing_events_total: number;
  false_accept_rate: number | null;
}
