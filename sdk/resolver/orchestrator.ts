import type { Address } from "viem";

import { VerdictService } from "../verdict-service";
import { VerdictSdk } from "../verdict-sdk";
import type { ResolverStore } from "./store";
import type {
  ResolverCycleSummary,
  ResolverRunOptions,
  ResolverState,
} from "./types";

function nowIso() {
  return new Date().toISOString();
}

function bigintMax(left: bigint, right: bigint) {
  return left > right ? left : right;
}

function parseBigInt(value: string | undefined, fallback = 0n) {
  if (!value) {
    return fallback;
  }
  return BigInt(value);
}

export class VerdictResolverOrchestrator {
  constructor(
    private readonly verdict: VerdictSdk,
    private readonly service: VerdictService,
    private readonly executor: Address,
    private readonly store: ResolverStore,
    private readonly options: ResolverRunOptions
  ) {}

  async loadState() {
    return this.store.load();
  }

  async runCycle(): Promise<ResolverCycleSummary> {
    const state = await this.store.load();
    const latestBlock = await this.verdict.getBlockNumber();

    let indexed = { registrations: 0, resolutions: 0 };
    if (Object.keys(state.slas).length === 0) {
      await this.bootstrapFromChainSnapshot(state, latestBlock);
    } else {
      indexed = await this.indexEvents(state, latestBlock);
    }

    const reconciledSlas = await this.reconcileCatalog(state, latestBlock);
    const queuedSlas = this.queueResolvableSlas(state, latestBlock);
    const processed = await this.processJobs(state);

    state.metrics.lastCycleAt = nowIso();
    await this.store.save(state);

    return {
      indexedRegistrations: indexed.registrations,
      indexedResolutions: indexed.resolutions,
      reconciledSlas,
      queuedSlas,
      processedJobs: processed.processedJobs,
      confirmedJobs: processed.confirmedJobs,
      retriedJobs: processed.retriedJobs,
      deadLetters: processed.deadLetters,
      latestBlock,
    };
  }

  private async bootstrapFromChainSnapshot(state: ResolverState, latestBlock: bigint) {
    const slaCount = await this.verdict.slaCount();
    for (let slaId = 1n; slaId <= slaCount; slaId += 1n) {
      await this.reconcileSingleSla(state, slaId, latestBlock);
    }

    state.indexer.lastIndexedBlock = latestBlock.toString();
  }

  private async indexEvents(state: ResolverState, latestBlock: bigint) {
    let registrations = 0;
    let resolutions = 0;
    let chunkSize = this.options.indexChunkSize;

    let fromBlock = parseBigInt(state.indexer.lastIndexedBlock, -1n) + 1n;
    if (fromBlock > latestBlock) {
      return { registrations, resolutions };
    }

    while (fromBlock <= latestBlock) {
      const toBlock =
        fromBlock + chunkSize - 1n > latestBlock ? latestBlock : fromBlock + chunkSize - 1n;

      let registeredLogs;
      let resolvedLogs;
      try {
        [registeredLogs, resolvedLogs] = await Promise.all([
          this.verdict.getRegisteredEvents(fromBlock, toBlock),
          this.verdict.getResolvedEvents(fromBlock, toBlock),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const needsSmallerRange =
          message.includes("block range greater than") || message.includes("query timeout");

        if (!needsSmallerRange || chunkSize === 1n) {
          throw error;
        }

        chunkSize = bigintMax(1n, chunkSize / 2n);
        continue;
      }

      for (const log of registeredLogs) {
        const args = log.args;
        const key = args.slaId.toString();
        const existing = state.slas[key];
        state.slas[key] = {
          slaId: key,
          agentA: args.agentA,
          agentB: args.agentB,
          targetAddress: args.targetAddress,
          targetAmount: args.targetAmount.toString(),
          targetBlock: args.targetBlock.toString(),
          collateral: args.collateral.toString(),
          resolved: existing?.resolved ?? false,
          status: existing?.status ?? "pending",
          currentBalance: existing?.currentBalance ?? "0",
          blocksRemaining: existing?.blocksRemaining ?? "0",
          registeredAtBlock: log.blockNumber?.toString(),
          resolvedAtBlock: existing?.resolvedAtBlock,
          resolvedOutcome: existing?.resolvedOutcome,
          indexedFromEvent: true,
          lastUpdatedAt: nowIso(),
          lastCheckedBlock: existing?.lastCheckedBlock,
        };
        registrations += 1;
      }

      for (const log of resolvedLogs) {
        const args = log.args;
        const key = args.slaId.toString();
        const existing = state.slas[key];
        if (!existing) {
          await this.reconcileSingleSla(state, args.slaId, latestBlock);
        }

        const current = state.slas[key];
        if (current) {
          current.resolved = true;
          current.status = args.met ? "met" : "slashed";
          current.resolvedOutcome = args.met ? "met" : "slashed";
          current.resolvedAtBlock = args.resolvedAtBlock.toString();
          current.lastUpdatedAt = nowIso();
        }

        const job = state.jobs[key];
        if (job) {
          job.status = "confirmed";
          job.lastSucceededAt = nowIso();
        }

        resolutions += 1;
      }

      state.indexer.lastIndexedBlock = toBlock.toString();
      fromBlock = toBlock + 1n;
    }

    state.metrics.indexedRegistrations += registrations;
    state.metrics.indexedResolutions += resolutions;
    return { registrations, resolutions };
  }

  private async reconcileCatalog(state: ResolverState, latestBlock: bigint) {
    const slaCount = await this.verdict.slaCount();
    let reconciled = 0;

    for (let slaId = 1n; slaId <= slaCount; slaId += 1n) {
      const key = slaId.toString();
      const known = state.slas[key];
      const shouldRefresh =
        !known ||
        !known.resolved ||
        parseBigInt(known.lastCheckedBlock, 0n) < latestBlock;

      if (!shouldRefresh) {
        continue;
      }

      await this.reconcileSingleSla(state, slaId, latestBlock);
      reconciled += 1;
    }

    state.metrics.reconciliationPasses += 1;
    state.indexer.lastReconciledAt = nowIso();
    return reconciled;
  }

  private async reconcileSingleSla(state: ResolverState, slaId: bigint, latestBlock: bigint) {
    const key = slaId.toString();
    const [sla, status] = await Promise.all([this.verdict.getSla(slaId), this.verdict.status(slaId)]);
    const current = state.slas[key];

    state.slas[key] = {
      slaId: key,
      agentA: sla.agentA,
      agentB: sla.agentB,
      targetAddress: sla.targetAddress,
      targetAmount: sla.targetAmount.toString(),
      targetBlock: sla.targetBlock.toString(),
      collateral: sla.collateral.toString(),
      resolved: sla.resolved,
      status: status.status,
      currentBalance: status.currentBalance.toString(),
      blocksRemaining: status.blocksRemaining.toString(),
      registeredAtBlock: current?.registeredAtBlock,
      resolvedAtBlock:
        sla.resolved ? current?.resolvedAtBlock ?? latestBlock.toString() : undefined,
      resolvedOutcome:
        sla.resolved && status.status !== "pending" ? status.status : undefined,
      indexedFromEvent: current?.indexedFromEvent ?? false,
      lastUpdatedAt: nowIso(),
      lastCheckedBlock: latestBlock.toString(),
    };

    const job = state.jobs[key];
    if (sla.resolved && job) {
      job.status = "confirmed";
      job.lastSucceededAt = nowIso();
      job.lastError = undefined;
    }
  }

  private queueResolvableSlas(state: ResolverState, latestBlock: bigint) {
    let queued = 0;

    for (const [key, sla] of Object.entries(state.slas)) {
      if (sla.resolved) {
        continue;
      }

      const targetBlock = BigInt(sla.targetBlock);
      if (latestBlock < targetBlock + this.options.confirmationBufferBlocks) {
        continue;
      }

      const existing = state.jobs[key];
      if (existing?.status === "running" || existing?.status === "confirmed" || existing?.status === "dead_letter") {
        continue;
      }

      if (existing?.status === "retrying" && existing.nextRetryAt) {
        const retryAt = Date.parse(existing.nextRetryAt);
        if (!Number.isNaN(retryAt) && retryAt > Date.now()) {
          continue;
        }
      }

      state.jobs[key] = {
        slaId: key,
        status: "queued",
        attemptCount: existing?.attemptCount ?? 0,
        nextRetryAt: undefined,
        txHash: existing?.txHash,
        lastError: existing?.lastError,
        lastAttemptAt: existing?.lastAttemptAt,
        lastSucceededAt: existing?.lastSucceededAt,
        claimedBy: undefined,
      };
      queued += 1;
    }

    state.metrics.queuedJobs += queued;
    return queued;
  }

  private async processJobs(state: ResolverState) {
    let processedJobs = 0;
    let confirmedJobs = 0;
    let retriedJobs = 0;
    let deadLetters = 0;

    const jobs = Object.values(state.jobs)
      .filter((job) => job.status === "queued" || job.status === "retrying")
      .slice(0, this.options.maxJobsPerCycle);

    for (const job of jobs) {
      processedJobs += 1;
      job.status = "running";
      job.claimedBy = this.options.actorId;
      job.attemptCount += 1;
      job.lastAttemptAt = nowIso();

      const slaId = BigInt(job.slaId);

      try {
        const result = await this.service.resolve(slaId, this.executor, {
          logSignal: this.options.logSignal,
          triggerX402Settlement: this.options.triggerX402Settlement,
        });

        job.txHash = result.txHash;
        if (result.tracking.status !== "confirmed") {
          throw new Error(`Resolution transaction ${result.txHash} finished with status ${result.tracking.status}`);
        }

        await this.reconcileSingleSla(state, slaId, await this.verdict.getBlockNumber());
        job.status = "confirmed";
        job.lastSucceededAt = nowIso();
        job.lastError = undefined;
        confirmedJobs += 1;
        state.metrics.successfulResolutions += 1;
      } catch (error) {
        await this.reconcileSingleSla(state, slaId, await this.verdict.getBlockNumber());
        const latestSla = state.slas[job.slaId];

        if (latestSla?.resolved) {
          job.status = "confirmed";
          job.lastSucceededAt = nowIso();
          job.lastError = undefined;
          confirmedJobs += 1;
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        job.lastError = message;
        state.metrics.failedAttempts += 1;

        if (job.attemptCount >= this.options.maxAttempts) {
          job.status = "dead_letter";
          job.nextRetryAt = undefined;
          deadLetters += 1;
          state.metrics.deadLetters += 1;
        } else {
          job.status = "retrying";
          job.nextRetryAt = new Date(
            Date.now() + this.options.retryBaseMs * 2 ** Math.max(job.attemptCount - 1, 0)
          ).toISOString();
          retriedJobs += 1;
        }
      }
    }

    return { processedJobs, confirmedJobs, retriedJobs, deadLetters };
  }
}
