import type { Address } from "viem";
import { Pool } from "pg";

import type { ResolverIndexedSla, ResolverJob, ResolverMetrics, ResolverState } from "./types";
import type { ResolverStore } from "./store";

function nowIso() {
  return new Date().toISOString();
}

function parseMetrics(row: any): ResolverMetrics {
  return {
    indexedRegistrations: Number(row.indexed_registrations ?? 0),
    indexedResolutions: Number(row.indexed_resolutions ?? 0),
    reconciliationPasses: Number(row.reconciliation_passes ?? 0),
    queuedJobs: Number(row.queued_jobs ?? 0),
    successfulResolutions: Number(row.successful_resolutions ?? 0),
    failedAttempts: Number(row.failed_attempts ?? 0),
    deadLetters: Number(row.dead_letters ?? 0),
    lastCycleAt: row.last_cycle_at ?? undefined,
  };
}

function blankMetrics(): ResolverMetrics {
  return {
    indexedRegistrations: 0,
    indexedResolutions: 0,
    reconciliationPasses: 0,
    queuedJobs: 0,
    successfulResolutions: 0,
    failedAttempts: 0,
    deadLetters: 0,
  };
}

export class PostgresResolverStore implements ResolverStore {
  constructor(
    private readonly pool: Pool,
    private readonly chainId: number,
    private readonly contractAddress: Address,
    private readonly deploymentBlock: bigint
  ) {}

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS resolver_metadata (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deployment_block TEXT NOT NULL,
        last_indexed_block TEXT NOT NULL,
        last_reconciled_at TIMESTAMPTZ,
        PRIMARY KEY (chain_id, contract_address)
      );

      CREATE TABLE IF NOT EXISTS resolver_metrics (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        indexed_registrations BIGINT NOT NULL DEFAULT 0,
        indexed_resolutions BIGINT NOT NULL DEFAULT 0,
        reconciliation_passes BIGINT NOT NULL DEFAULT 0,
        queued_jobs BIGINT NOT NULL DEFAULT 0,
        successful_resolutions BIGINT NOT NULL DEFAULT 0,
        failed_attempts BIGINT NOT NULL DEFAULT 0,
        dead_letters BIGINT NOT NULL DEFAULT 0,
        last_cycle_at TIMESTAMPTZ,
        PRIMARY KEY (chain_id, contract_address)
      );

      CREATE TABLE IF NOT EXISTS resolver_slas (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        sla_id TEXT NOT NULL,
        agent_a TEXT NOT NULL,
        agent_b TEXT NOT NULL,
        target_address TEXT NOT NULL,
        target_amount TEXT NOT NULL,
        target_block TEXT NOT NULL,
        collateral TEXT NOT NULL,
        resolved BOOLEAN NOT NULL,
        status TEXT NOT NULL,
        current_balance TEXT NOT NULL,
        blocks_remaining TEXT NOT NULL,
        registered_at_block TEXT,
        resolved_at_block TEXT,
        resolved_outcome TEXT,
        indexed_from_event BOOLEAN NOT NULL,
        last_updated_at TIMESTAMPTZ NOT NULL,
        last_checked_block TEXT,
        PRIMARY KEY (chain_id, contract_address, sla_id)
      );

      CREATE TABLE IF NOT EXISTS resolver_jobs (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        sla_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        next_retry_at TIMESTAMPTZ,
        tx_hash TEXT,
        last_error TEXT,
        last_attempt_at TIMESTAMPTZ,
        last_succeeded_at TIMESTAMPTZ,
        claimed_by TEXT,
        PRIMARY KEY (chain_id, contract_address, sla_id)
      );
    `);

    const now = nowIso();
    await this.pool.query(
      `
      INSERT INTO resolver_metadata (
        chain_id, contract_address, version, created_at, updated_at, deployment_block, last_indexed_block
      ) VALUES ($1, $2, 1, $3, $3, $4, $5)
      ON CONFLICT (chain_id, contract_address) DO NOTHING
      `,
      [this.chainId, this.contractAddress, now, this.deploymentBlock.toString(), (this.deploymentBlock - 1n).toString()]
    );

    await this.pool.query(
      `
      INSERT INTO resolver_metrics (
        chain_id, contract_address
      ) VALUES ($1, $2)
      ON CONFLICT (chain_id, contract_address) DO NOTHING
      `,
      [this.chainId, this.contractAddress]
    );
  }

  async load(): Promise<ResolverState> {
    await this.initialize();

    const metadataResult = await this.pool.query(
      `SELECT * FROM resolver_metadata WHERE chain_id = $1 AND contract_address = $2`,
      [this.chainId, this.contractAddress]
    );
    const metricsResult = await this.pool.query(
      `SELECT * FROM resolver_metrics WHERE chain_id = $1 AND contract_address = $2`,
      [this.chainId, this.contractAddress]
    );
    const slasResult = await this.pool.query(
      `SELECT * FROM resolver_slas WHERE chain_id = $1 AND contract_address = $2`,
      [this.chainId, this.contractAddress]
    );
    const jobsResult = await this.pool.query(
      `SELECT * FROM resolver_jobs WHERE chain_id = $1 AND contract_address = $2`,
      [this.chainId, this.contractAddress]
    );

    const metadata = metadataResult.rows[0];
    if (!metadata) {
      throw new Error("Resolver metadata row is missing after initialization");
    }

    const slas = Object.fromEntries(
      slasResult.rows.map((row) => [
        row.sla_id,
        {
          slaId: row.sla_id,
          agentA: row.agent_a,
          agentB: row.agent_b,
          targetAddress: row.target_address,
          targetAmount: row.target_amount,
          targetBlock: row.target_block,
          collateral: row.collateral,
          resolved: row.resolved,
          status: row.status,
          currentBalance: row.current_balance,
          blocksRemaining: row.blocks_remaining,
          registeredAtBlock: row.registered_at_block ?? undefined,
          resolvedAtBlock: row.resolved_at_block ?? undefined,
          resolvedOutcome: row.resolved_outcome ?? undefined,
          indexedFromEvent: row.indexed_from_event,
          lastUpdatedAt: row.last_updated_at,
          lastCheckedBlock: row.last_checked_block ?? undefined,
        } satisfies ResolverIndexedSla,
      ])
    );

    const jobs = Object.fromEntries(
      jobsResult.rows.map((row) => [
        row.sla_id,
        {
          slaId: row.sla_id,
          status: row.status,
          attemptCount: Number(row.attempt_count),
          nextRetryAt: row.next_retry_at ?? undefined,
          txHash: row.tx_hash ?? undefined,
          lastError: row.last_error ?? undefined,
          lastAttemptAt: row.last_attempt_at ?? undefined,
          lastSucceededAt: row.last_succeeded_at ?? undefined,
          claimedBy: row.claimed_by ?? undefined,
        } satisfies ResolverJob,
      ])
    );

    return {
      version: 1,
      chainId: metadata.chain_id,
      contractAddress: metadata.contract_address,
      createdAt: metadata.created_at,
      updatedAt: metadata.updated_at,
      indexer: {
        deploymentBlock: metadata.deployment_block,
        lastIndexedBlock: metadata.last_indexed_block,
        lastReconciledAt: metadata.last_reconciled_at ?? undefined,
      },
      slas,
      jobs,
      metrics: metricsResult.rows[0] ? parseMetrics(metricsResult.rows[0]) : blankMetrics(),
    };
  }

  async save(state: ResolverState): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const updatedAt = nowIso();
      state.updatedAt = updatedAt;

      await client.query(
        `
        UPDATE resolver_metadata
        SET version = $3,
            updated_at = $4,
            deployment_block = $5,
            last_indexed_block = $6,
            last_reconciled_at = $7
        WHERE chain_id = $1 AND contract_address = $2
        `,
        [
          state.chainId,
          state.contractAddress,
          state.version,
          updatedAt,
          state.indexer.deploymentBlock,
          state.indexer.lastIndexedBlock,
          state.indexer.lastReconciledAt ?? null,
        ]
      );

      await client.query(
        `
        INSERT INTO resolver_metrics (
          chain_id, contract_address, indexed_registrations, indexed_resolutions, reconciliation_passes,
          queued_jobs, successful_resolutions, failed_attempts, dead_letters, last_cycle_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (chain_id, contract_address)
        DO UPDATE SET
          indexed_registrations = EXCLUDED.indexed_registrations,
          indexed_resolutions = EXCLUDED.indexed_resolutions,
          reconciliation_passes = EXCLUDED.reconciliation_passes,
          queued_jobs = EXCLUDED.queued_jobs,
          successful_resolutions = EXCLUDED.successful_resolutions,
          failed_attempts = EXCLUDED.failed_attempts,
          dead_letters = EXCLUDED.dead_letters,
          last_cycle_at = EXCLUDED.last_cycle_at
        `,
        [
          state.chainId,
          state.contractAddress,
          state.metrics.indexedRegistrations,
          state.metrics.indexedResolutions,
          state.metrics.reconciliationPasses,
          state.metrics.queuedJobs,
          state.metrics.successfulResolutions,
          state.metrics.failedAttempts,
          state.metrics.deadLetters,
          state.metrics.lastCycleAt ?? null,
        ]
      );

      await client.query(
        `DELETE FROM resolver_slas WHERE chain_id = $1 AND contract_address = $2`,
        [state.chainId, state.contractAddress]
      );
      for (const sla of Object.values(state.slas)) {
        await client.query(
          `
          INSERT INTO resolver_slas (
            chain_id, contract_address, sla_id, agent_a, agent_b, target_address, target_amount, target_block,
            collateral, resolved, status, current_balance, blocks_remaining, registered_at_block, resolved_at_block,
            resolved_outcome, indexed_from_event, last_updated_at, last_checked_block
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          `,
          [
            state.chainId,
            state.contractAddress,
            sla.slaId,
            sla.agentA,
            sla.agentB,
            sla.targetAddress,
            sla.targetAmount,
            sla.targetBlock,
            sla.collateral,
            sla.resolved,
            sla.status,
            sla.currentBalance,
            sla.blocksRemaining,
            sla.registeredAtBlock ?? null,
            sla.resolvedAtBlock ?? null,
            sla.resolvedOutcome ?? null,
            sla.indexedFromEvent,
            sla.lastUpdatedAt,
            sla.lastCheckedBlock ?? null,
          ]
        );
      }

      await client.query(
        `DELETE FROM resolver_jobs WHERE chain_id = $1 AND contract_address = $2`,
        [state.chainId, state.contractAddress]
      );
      for (const job of Object.values(state.jobs)) {
        await client.query(
          `
          INSERT INTO resolver_jobs (
            chain_id, contract_address, sla_id, status, attempt_count, next_retry_at, tx_hash,
            last_error, last_attempt_at, last_succeeded_at, claimed_by
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `,
          [
            state.chainId,
            state.contractAddress,
            job.slaId,
            job.status,
            job.attemptCount,
            job.nextRetryAt ?? null,
            job.txHash ?? null,
            job.lastError ?? null,
            job.lastAttemptAt ?? null,
            job.lastSucceededAt ?? null,
            job.claimedBy ?? null,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  describe() {
    return `postgres://${this.contractAddress}@chain-${this.chainId}`;
  }
}
