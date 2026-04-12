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
