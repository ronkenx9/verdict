import { randomUUID } from "node:crypto";

import type { Address } from "viem";
import type { Pool, PoolClient } from "pg";

import { VerdictService } from "../verdict-service";
import { VerdictSdk } from "../verdict-sdk";

type HaResolverOptions = {
  actorId: string;
  maxJobsPerCycle: number;
  confirmationBufferBlocks: bigint;
  retryBaseMs: number;
  maxAttempts: number;
  indexChunkSize: bigint;
  leaseMs: number;
  logSignal: boolean;
  triggerX402Settlement: boolean;
};

type ClaimedJob = {
  slaId: bigint;
  attemptCount: number;
  leaseToken: string;
};

function nowIso() {
  return new Date().toISOString();
}

function bigintMin(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class PostgresHaResolver {
  constructor(
    private readonly pool: Pool,
    private readonly verdict: VerdictSdk,
    private readonly service: VerdictService,
    private readonly executor: Address,
    private readonly chainId: number,
    private readonly contractAddress: Address,
    private readonly deploymentBlock: bigint,
    private readonly options: HaResolverOptions
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
        claimed_until TIMESTAMPTZ,
        lease_token TEXT,
        PRIMARY KEY (chain_id, contract_address, sla_id)
      );

      CREATE INDEX IF NOT EXISTS resolver_jobs_claim_idx
      ON resolver_jobs (chain_id, contract_address, status, next_retry_at, claimed_until);
    `);

    const now = nowIso();
    await this.pool.query(
      `
      INSERT INTO resolver_metadata (
        chain_id, contract_address, version, created_at, updated_at, deployment_block, last_indexed_block
      ) VALUES ($1, $2, 1, $3, $3, $4, $5)
      ON CONFLICT (chain_id, contract_address) DO NOTHING
      `,
      [
        this.chainId,
        this.contractAddress,
        now,
        this.deploymentBlock.toString(),
        (this.deploymentBlock - 1n).toString(),
      ]
    );

    await this.pool.query(
      `
      INSERT INTO resolver_metrics (chain_id, contract_address)
      VALUES ($1, $2)
      ON CONFLICT (chain_id, contract_address) DO NOTHING
      `,
      [this.chainId, this.contractAddress]
    );
  }

  async getStatus() {
    await this.initialize();
    const latestBlock = await this.verdict.getBlockNumber();
    const [metadataResult, metricsResult, slasResult, jobsResult] = await Promise.all([
      this.pool.query(
        `SELECT * FROM resolver_metadata WHERE chain_id = $1 AND contract_address = $2`,
        [this.chainId, this.contractAddress]
      ),
      this.pool.query(
        `SELECT * FROM resolver_metrics WHERE chain_id = $1 AND contract_address = $2`,
        [this.chainId, this.contractAddress]
      ),
      this.pool.query(
        `
        SELECT sla_id, target_block, blocks_remaining, collateral
        FROM resolver_slas
        WHERE chain_id = $1
          AND contract_address = $2
          AND resolved = false
          AND CAST(target_block AS NUMERIC) <= $3
        ORDER BY CAST(sla_id AS NUMERIC)
        `,
        [this.chainId, this.contractAddress, latestBlock.toString()]
      ),
      this.pool.query(
        `
        SELECT status, COUNT(*)::INT AS count
        FROM resolver_jobs
        WHERE chain_id = $1 AND contract_address = $2
        GROUP BY status
        `,
        [this.chainId, this.contractAddress]
      ),
    ]);

    return {
      backend: "postgres" as const,
      latestBlock: latestBlock.toString(),
      indexedSlas: await this.countRows("resolver_slas"),
      unresolvedExpired: slasResult.rows.map((row) => ({
        slaId: row.sla_id,
        targetBlock: row.target_block,
        blocksRemaining: row.blocks_remaining,
        collateral: row.collateral,
      })),
      jobsByStatus: Object.fromEntries(jobsResult.rows.map((row) => [row.status, row.count])),
      metrics: metricsResult.rows[0] ?? {},
      indexer: metadataResult.rows[0] ?? {},
    };
  }

  async runIndexerCycle() {
    await this.initialize();

    const latestBlock = await this.verdict.getBlockNumber();
    const metadata = await this.getMetadata();
    const existingCount = await this.countRows("resolver_slas");

    if (existingCount === 0) {
      await this.bootstrapSnapshot(latestBlock);
      return {
        mode: "snapshot",
        latestBlock: latestBlock.toString(),
        indexedRegistrations: 0,
        indexedResolutions: 0,
      };
    }

    let indexedRegistrations = 0;
    let indexedResolutions = 0;
    let fromBlock = BigInt(metadata.last_indexed_block) + 1n;
    let chunkSize = this.options.indexChunkSize;

    while (fromBlock <= latestBlock) {
      const toBlock = bigintMin(fromBlock + chunkSize - 1n, latestBlock);

      let registeredLogs;
      let resolvedLogs;
      try {
        [registeredLogs, resolvedLogs] = await Promise.all([
          this.verdict.getRegisteredEvents(fromBlock, toBlock),
          this.verdict.getResolvedEvents(fromBlock, toBlock),
        ]);
      } catch (error) {
        const message = stringifyError(error).toLowerCase();
        if ((message.includes("block range greater than") || message.includes("query timeout")) && chunkSize > 1n) {
          chunkSize = bigintMin(chunkSize / 2n || 1n, chunkSize);
          if (chunkSize < 1n) {
            chunkSize = 1n;
          }
          continue;
        }
        throw error;
      }

      for (const log of registeredLogs) {
        const args = log.args;
        await this.pool.query(
          `
          INSERT INTO resolver_slas (
            chain_id, contract_address, sla_id, agent_a, agent_b, target_address, target_amount, target_block,
            collateral, resolved, status, current_balance, blocks_remaining, registered_at_block,
            resolved_at_block, resolved_outcome, indexed_from_event, last_updated_at, last_checked_block
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,'pending','0','0',$10,NULL,NULL,true,$11,NULL)
          ON CONFLICT (chain_id, contract_address, sla_id)
          DO UPDATE SET
            agent_a = EXCLUDED.agent_a,
            agent_b = EXCLUDED.agent_b,
            target_address = EXCLUDED.target_address,
            target_amount = EXCLUDED.target_amount,
            target_block = EXCLUDED.target_block,
            collateral = EXCLUDED.collateral,
            registered_at_block = COALESCE(resolver_slas.registered_at_block, EXCLUDED.registered_at_block),
            indexed_from_event = true,
            last_updated_at = EXCLUDED.last_updated_at
          `,
          [
            this.chainId,
            this.contractAddress,
            args.slaId.toString(),
            args.agentA,
            args.agentB,
            args.targetAddress,
            args.targetAmount.toString(),
            args.targetBlock.toString(),
            args.collateral.toString(),
            log.blockNumber?.toString() ?? null,
            nowIso(),
          ]
        );
        indexedRegistrations += 1;
      }

      for (const log of resolvedLogs) {
        const args = log.args;
        await this.pool.query(
          `
          UPDATE resolver_slas
          SET resolved = true,
              status = $4,
              resolved_outcome = $4,
              resolved_at_block = $5,
              indexed_from_event = true,
              last_updated_at = $6
          WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3
          `,
          [
            this.chainId,
            this.contractAddress,
            args.slaId.toString(),
            args.met ? "met" : "slashed",
            args.resolvedAtBlock.toString(),
            nowIso(),
          ]
        );
        await this.pool.query(
          `
          UPDATE resolver_jobs
          SET status = 'confirmed',
              last_succeeded_at = $4,
              claimed_until = NULL,
              lease_token = NULL,
              last_error = NULL
          WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3
          `,
          [this.chainId, this.contractAddress, args.slaId.toString(), nowIso()]
        );
        indexedResolutions += 1;
      }

      await this.pool.query(
        `
        UPDATE resolver_metadata
        SET last_indexed_block = $3, updated_at = $4
        WHERE chain_id = $1 AND contract_address = $2
        `,
        [this.chainId, this.contractAddress, toBlock.toString(), nowIso()]
      );

      fromBlock = toBlock + 1n;
    }

    await this.bumpMetrics({
      indexedRegistrations,
      indexedResolutions,
      lastCycleAt: nowIso(),
    });

    return {
      mode: "logs",
      latestBlock: latestBlock.toString(),
      indexedRegistrations,
      indexedResolutions,
    };
  }

  async runReconcilerCycle() {
    await this.initialize();

    const latestBlock = await this.verdict.getBlockNumber();
    const slaCount = await this.verdict.slaCount();
    let reconciledSlas = 0;
    let queuedJobs = 0;

    for (let slaId = 1n; slaId <= slaCount; slaId += 1n) {
      const [sla, status] = await Promise.all([this.verdict.getSla(slaId), this.verdict.status(slaId)]);
      await this.pool.query(
        `
        INSERT INTO resolver_slas (
          chain_id, contract_address, sla_id, agent_a, agent_b, target_address, target_amount, target_block,
          collateral, resolved, status, current_balance, blocks_remaining, registered_at_block, resolved_at_block,
          resolved_outcome, indexed_from_event, last_updated_at, last_checked_block
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,false,$16,$17)
        ON CONFLICT (chain_id, contract_address, sla_id)
        DO UPDATE SET
          agent_a = EXCLUDED.agent_a,
          agent_b = EXCLUDED.agent_b,
          target_address = EXCLUDED.target_address,
          target_amount = EXCLUDED.target_amount,
          target_block = EXCLUDED.target_block,
          collateral = EXCLUDED.collateral,
          resolved = EXCLUDED.resolved,
          status = EXCLUDED.status,
          current_balance = EXCLUDED.current_balance,
          blocks_remaining = EXCLUDED.blocks_remaining,
          resolved_at_block = EXCLUDED.resolved_at_block,
          resolved_outcome = EXCLUDED.resolved_outcome,
          last_updated_at = EXCLUDED.last_updated_at,
          last_checked_block = EXCLUDED.last_checked_block
        `,
        [
          this.chainId,
          this.contractAddress,
          slaId.toString(),
          sla.agentA,
          sla.agentB,
          sla.targetAddress,
          sla.targetAmount.toString(),
          sla.targetBlock.toString(),
          sla.collateral.toString(),
          sla.resolved,
          status.status,
          status.currentBalance.toString(),
          status.blocksRemaining.toString(),
          sla.resolved ? latestBlock.toString() : null,
          sla.resolved && status.status !== "pending" ? status.status : null,
          nowIso(),
          latestBlock.toString(),
        ]
      );
      reconciledSlas += 1;

      if (!sla.resolved && latestBlock >= sla.targetBlock + this.options.confirmationBufferBlocks) {
        await this.pool.query(
          `
          INSERT INTO resolver_jobs (
            chain_id, contract_address, sla_id, status, attempt_count
          ) VALUES ($1, $2, $3, 'queued', 0)
          ON CONFLICT (chain_id, contract_address, sla_id)
          DO UPDATE SET
            status = CASE
              WHEN resolver_jobs.status IN ('confirmed', 'dead_letter') THEN resolver_jobs.status
              WHEN resolver_jobs.status = 'running' AND resolver_jobs.claimed_until IS NOT NULL AND resolver_jobs.claimed_until > NOW() THEN resolver_jobs.status
              ELSE 'queued'
            END
          `,
          [this.chainId, this.contractAddress, slaId.toString()]
        );
        queuedJobs += 1;
      }

      if (sla.resolved) {
        await this.pool.query(
          `
          UPDATE resolver_jobs
          SET status = 'confirmed',
              last_succeeded_at = COALESCE(last_succeeded_at, $4),
              claimed_until = NULL,
              lease_token = NULL,
              last_error = NULL
          WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3
          `,
          [this.chainId, this.contractAddress, slaId.toString(), nowIso()]
        );
      }
    }

    await this.pool.query(
      `
      UPDATE resolver_metadata
      SET last_reconciled_at = $3, updated_at = $3
      WHERE chain_id = $1 AND contract_address = $2
      `,
      [this.chainId, this.contractAddress, nowIso()]
    );

    await this.bumpMetrics({
      reconciliationPasses: 1,
      queuedJobs,
      lastCycleAt: nowIso(),
    });

    return {
      reconciledSlas,
      queuedJobs,
      latestBlock: latestBlock.toString(),
    };
  }

  async runWorkerCycle() {
    await this.initialize();
    let processedJobs = 0;
    let confirmedJobs = 0;
    let retriedJobs = 0;
    let deadLetters = 0;

    for (let i = 0; i < this.options.maxJobsPerCycle; i += 1) {
      const claimed = await this.claimNextJob();
      if (!claimed) {
        break;
      }

      processedJobs += 1;
      const slaId = claimed.slaId;

      try {
        const result = await this.service.resolve(slaId, this.executor, {
          logSignal: this.options.logSignal,
          triggerX402Settlement: this.options.triggerX402Settlement,
        });

        if (result.tracking.status === "confirmed") {
          await this.refreshSlaAndFinalizeJob(slaId, claimed.leaseToken, "confirmed", undefined, result.txHash);
          confirmedJobs += 1;
          await this.bumpMetrics({
            successfulResolutions: 1,
            lastCycleAt: nowIso(),
          });
        } else {
          await this.pool.query(
            `
            UPDATE resolver_jobs
            SET tx_hash = $5,
                claimed_until = NOW() + ($6::TEXT || ' milliseconds')::INTERVAL
            WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3 AND lease_token = $4
            `,
            [
              this.chainId,
              this.contractAddress,
              slaId.toString(),
              claimed.leaseToken,
              result.txHash,
              this.options.leaseMs,
            ]
          );
        }
      } catch (error) {
        const message = stringifyError(error);
        const finalized = await this.refreshSlaAndMaybeMarkResolved(slaId, claimed.leaseToken);
        if (finalized) {
          confirmedJobs += 1;
          continue;
        }

        if (claimed.attemptCount >= this.options.maxAttempts) {
          await this.updateJobFailure(slaId, claimed.leaseToken, "dead_letter", message);
          deadLetters += 1;
          await this.bumpMetrics({
            failedAttempts: 1,
            deadLetters: 1,
            lastCycleAt: nowIso(),
          });
        } else {
          await this.updateJobFailure(slaId, claimed.leaseToken, "retrying", message, claimed.attemptCount);
          retriedJobs += 1;
          await this.bumpMetrics({
            failedAttempts: 1,
            lastCycleAt: nowIso(),
          });
        }
      }
    }

    return { processedJobs, confirmedJobs, retriedJobs, deadLetters };
  }

  async runAllCycle() {
    const indexer = await this.runIndexerCycle();
    const reconciler = await this.runReconcilerCycle();
    const worker = await this.runWorkerCycle();
    return { indexer, reconciler, worker };
  }

  private async bootstrapSnapshot(latestBlock: bigint) {
    const slaCount = await this.verdict.slaCount();
    for (let slaId = 1n; slaId <= slaCount; slaId += 1n) {
      const [sla, status] = await Promise.all([this.verdict.getSla(slaId), this.verdict.status(slaId)]);
      await this.pool.query(
        `
        INSERT INTO resolver_slas (
          chain_id, contract_address, sla_id, agent_a, agent_b, target_address, target_amount, target_block,
          collateral, resolved, status, current_balance, blocks_remaining, registered_at_block, resolved_at_block,
          resolved_outcome, indexed_from_event, last_updated_at, last_checked_block
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,false,$16,$17)
        ON CONFLICT (chain_id, contract_address, sla_id)
        DO UPDATE SET
          agent_a = EXCLUDED.agent_a,
          agent_b = EXCLUDED.agent_b,
          target_address = EXCLUDED.target_address,
          target_amount = EXCLUDED.target_amount,
          target_block = EXCLUDED.target_block,
          collateral = EXCLUDED.collateral,
          resolved = EXCLUDED.resolved,
          status = EXCLUDED.status,
          current_balance = EXCLUDED.current_balance,
          blocks_remaining = EXCLUDED.blocks_remaining,
          resolved_at_block = EXCLUDED.resolved_at_block,
          resolved_outcome = EXCLUDED.resolved_outcome,
          last_updated_at = EXCLUDED.last_updated_at,
          last_checked_block = EXCLUDED.last_checked_block
        `,
        [
          this.chainId,
          this.contractAddress,
          slaId.toString(),
          sla.agentA,
          sla.agentB,
          sla.targetAddress,
          sla.targetAmount.toString(),
          sla.targetBlock.toString(),
          sla.collateral.toString(),
          sla.resolved,
          status.status,
          status.currentBalance.toString(),
          status.blocksRemaining.toString(),
          sla.resolved ? latestBlock.toString() : null,
          sla.resolved && status.status !== "pending" ? status.status : null,
          nowIso(),
          latestBlock.toString(),
        ]
      );
    }

    await this.pool.query(
      `
      UPDATE resolver_metadata
      SET last_indexed_block = $3, updated_at = $4
      WHERE chain_id = $1 AND contract_address = $2
      `,
      [this.chainId, this.contractAddress, latestBlock.toString(), nowIso()]
    );
  }

  private async claimNextJob(): Promise<ClaimedJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const leaseToken = randomUUID();
      const result = await client.query(
        `
        WITH candidate AS (
          SELECT sla_id
          FROM resolver_jobs
          WHERE chain_id = $1
            AND contract_address = $2
            AND (
              status IN ('queued', 'retrying')
              OR (status = 'running' AND claimed_until IS NOT NULL AND claimed_until < NOW())
            )
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY
            CASE status
              WHEN 'queued' THEN 0
              WHEN 'retrying' THEN 1
              ELSE 2
            END,
            COALESCE(last_attempt_at, TIMESTAMPTZ 'epoch') ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE resolver_jobs AS jobs
        SET status = 'running',
            attempt_count = jobs.attempt_count + 1,
            claimed_by = $3,
            claimed_until = NOW() + ($4::TEXT || ' milliseconds')::INTERVAL,
            lease_token = $5,
            last_attempt_at = NOW()
        FROM candidate
        WHERE jobs.chain_id = $1
          AND jobs.contract_address = $2
          AND jobs.sla_id = candidate.sla_id
        RETURNING jobs.sla_id, jobs.attempt_count, jobs.lease_token
        `,
        [
          this.chainId,
          this.contractAddress,
          this.options.actorId,
          this.options.leaseMs,
          leaseToken,
        ]
      );
      await client.query("COMMIT");

      if (result.rowCount !== 1) {
        return null;
      }

      const row = result.rows[0];
      return {
        slaId: BigInt(row.sla_id),
        attemptCount: Number(row.attempt_count),
        leaseToken: row.lease_token,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshSlaAndFinalizeJob(
    slaId: bigint,
    leaseToken: string,
    finalStatus: "confirmed",
    lastError?: string,
    txHash?: string
  ) {
    const latestBlock = await this.verdict.getBlockNumber();
    const [sla, status] = await Promise.all([this.verdict.getSla(slaId), this.verdict.status(slaId)]);

    await this.pool.query(
      `
      UPDATE resolver_slas
      SET resolved = $4,
          status = $5,
          current_balance = $6,
          blocks_remaining = $7,
          resolved_at_block = $8,
          resolved_outcome = $9,
          last_updated_at = $10,
          last_checked_block = $11
      WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3
      `,
      [
        this.chainId,
        this.contractAddress,
        slaId.toString(),
        sla.resolved,
        status.status,
        status.currentBalance.toString(),
        status.blocksRemaining.toString(),
        sla.resolved ? latestBlock.toString() : null,
        sla.resolved && status.status !== "pending" ? status.status : null,
        nowIso(),
        latestBlock.toString(),
      ]
    );

    await this.pool.query(
      `
      UPDATE resolver_jobs
      SET status = $5,
          tx_hash = COALESCE($6, tx_hash),
          last_succeeded_at = NOW(),
          last_error = $7,
          claimed_until = NULL,
          lease_token = NULL
      WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3 AND lease_token = $4
      `,
      [
        this.chainId,
        this.contractAddress,
        slaId.toString(),
        leaseToken,
        finalStatus,
        txHash ?? null,
        lastError ?? null,
      ]
    );
  }

  private async refreshSlaAndMaybeMarkResolved(slaId: bigint, leaseToken: string) {
    const latestBlock = await this.verdict.getBlockNumber();
    const [sla, status] = await Promise.all([this.verdict.getSla(slaId), this.verdict.status(slaId)]);

    await this.pool.query(
      `
      UPDATE resolver_slas
      SET resolved = $4,
          status = $5,
          current_balance = $6,
          blocks_remaining = $7,
          resolved_at_block = $8,
          resolved_outcome = $9,
          last_updated_at = $10,
          last_checked_block = $11
      WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3
      `,
      [
        this.chainId,
        this.contractAddress,
        slaId.toString(),
        sla.resolved,
        status.status,
        status.currentBalance.toString(),
        status.blocksRemaining.toString(),
        sla.resolved ? latestBlock.toString() : null,
        sla.resolved && status.status !== "pending" ? status.status : null,
        nowIso(),
        latestBlock.toString(),
      ]
    );

    if (!sla.resolved) {
      return false;
    }

    await this.pool.query(
      `
      UPDATE resolver_jobs
      SET status = 'confirmed',
          last_succeeded_at = NOW(),
          last_error = NULL,
          claimed_until = NULL,
          lease_token = NULL
      WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3 AND lease_token = $4
      `,
      [this.chainId, this.contractAddress, slaId.toString(), leaseToken]
    );
    return true;
  }

  private async updateJobFailure(
    slaId: bigint,
    leaseToken: string,
    status: "retrying" | "dead_letter",
    message: string,
    attemptCount?: number
  ) {
    const nextRetryAt =
      status === "retrying" && attemptCount
        ? new Date(Date.now() + this.options.retryBaseMs * 2 ** Math.max(attemptCount - 1, 0)).toISOString()
        : null;
    await this.pool.query(
      `
      UPDATE resolver_jobs
      SET status = $5,
          last_error = $6,
          next_retry_at = $7,
          claimed_until = NULL,
          lease_token = NULL
      WHERE chain_id = $1 AND contract_address = $2 AND sla_id = $3 AND lease_token = $4
      `,
      [
        this.chainId,
        this.contractAddress,
        slaId.toString(),
        leaseToken,
        status,
        message,
        nextRetryAt,
      ]
    );
  }

  private async getMetadata() {
    const result = await this.pool.query(
      `SELECT * FROM resolver_metadata WHERE chain_id = $1 AND contract_address = $2`,
      [this.chainId, this.contractAddress]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("resolver metadata missing");
    }
    return row;
  }

  private async countRows(tableName: "resolver_slas" | "resolver_jobs") {
    const result = await this.pool.query(
      `SELECT COUNT(*)::INT AS count FROM ${tableName} WHERE chain_id = $1 AND contract_address = $2`,
      [this.chainId, this.contractAddress]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async bumpMetrics(delta: Partial<Record<keyof ReturnType<typeof this.blankMetricsShape>, number | string>>) {
    await this.pool.query(
      `
      UPDATE resolver_metrics
      SET indexed_registrations = indexed_registrations + $3,
          indexed_resolutions = indexed_resolutions + $4,
          reconciliation_passes = reconciliation_passes + $5,
          queued_jobs = queued_jobs + $6,
          successful_resolutions = successful_resolutions + $7,
          failed_attempts = failed_attempts + $8,
          dead_letters = dead_letters + $9,
          last_cycle_at = COALESCE($10, last_cycle_at)
      WHERE chain_id = $1 AND contract_address = $2
      `,
      [
        this.chainId,
        this.contractAddress,
        Number(delta.indexedRegistrations ?? 0),
        Number(delta.indexedResolutions ?? 0),
        Number(delta.reconciliationPasses ?? 0),
        Number(delta.queuedJobs ?? 0),
        Number(delta.successfulResolutions ?? 0),
        Number(delta.failedAttempts ?? 0),
        Number(delta.deadLetters ?? 0),
        typeof delta.lastCycleAt === "string" ? delta.lastCycleAt : null,
      ]
    );
  }

  private blankMetricsShape() {
    return {
      indexedRegistrations: 0,
      indexedResolutions: 0,
      reconciliationPasses: 0,
      queuedJobs: 0,
      successfulResolutions: 0,
      failedAttempts: 0,
      deadLetters: 0,
      lastCycleAt: "",
    };
  }
}
