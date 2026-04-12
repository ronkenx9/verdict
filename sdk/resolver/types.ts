import type { Address, Hex } from "viem";

export type ResolverJobStatus =
  | "queued"
  | "running"
  | "confirmed"
  | "retrying"
  | "dead_letter";

export type ResolverLifecycleStatus = "pending" | "met" | "slashed";

export type ResolverIndexedSla = {
  slaId: string;
  agentA: Address;
  agentB: Address;
  targetAddress: Address;
  targetAmount: string;
  targetBlock: string;
  collateral: string;
  resolved: boolean;
  status: ResolverLifecycleStatus;
  currentBalance: string;
  blocksRemaining: string;
  registeredAtBlock?: string;
  resolvedAtBlock?: string;
  resolvedOutcome?: "met" | "slashed";
  indexedFromEvent: boolean;
  lastUpdatedAt: string;
  lastCheckedBlock?: string;
};

export type ResolverJob = {
  slaId: string;
  status: ResolverJobStatus;
  attemptCount: number;
  nextRetryAt?: string;
  txHash?: Hex;
  lastError?: string;
  lastAttemptAt?: string;
  lastSucceededAt?: string;
  claimedBy?: string;
};

export type ResolverMetrics = {
  indexedRegistrations: number;
  indexedResolutions: number;
  reconciliationPasses: number;
  queuedJobs: number;
  successfulResolutions: number;
  failedAttempts: number;
  deadLetters: number;
  lastCycleAt?: string;
};

export type ResolverState = {
  version: 1;
  chainId: number;
  contractAddress: Address;
  createdAt: string;
  updatedAt: string;
  indexer: {
    deploymentBlock: string;
    lastIndexedBlock: string;
    lastReconciledAt?: string;
  };
  slas: Record<string, ResolverIndexedSla>;
  jobs: Record<string, ResolverJob>;
  metrics: ResolverMetrics;
};

export type ResolverRunOptions = {
  actorId: string;
  maxJobsPerCycle: number;
  confirmationBufferBlocks: bigint;
  retryBaseMs: number;
  maxAttempts: number;
  indexChunkSize: bigint;
  logSignal: boolean;
  triggerX402Settlement: boolean;
};

export type ResolverCycleSummary = {
  indexedRegistrations: number;
  indexedResolutions: number;
  reconciledSlas: number;
  queuedSlas: number;
  processedJobs: number;
  confirmedJobs: number;
  retriedJobs: number;
  deadLetters: number;
  latestBlock: bigint;
};
