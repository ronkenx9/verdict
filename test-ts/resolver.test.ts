import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Address, Hex } from "viem";

import { VerdictResolverOrchestrator } from "../sdk/resolver/orchestrator";
import { FileResolverStore } from "../sdk/resolver/store";

type FakeSla = {
  agentA: Address;
  agentB: Address;
  targetAddress: Address;
  targetAmount: bigint;
  targetBlock: bigint;
  collateral: bigint;
  resolved: boolean;
  status: "pending" | "met" | "slashed";
  currentBalance: bigint;
  blocksRemaining: bigint;
};

class FakeVerdictSdk {
  currentBlock = 0n;
  slas = new Map<bigint, FakeSla>();
  registeredEvents: any[] = [];
  resolvedEvents: any[] = [];

  async getBlockNumber() {
    return this.currentBlock;
  }

  async getRegisteredEvents(fromBlock: bigint, toBlock: bigint) {
    return this.registeredEvents.filter(
      (event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock
    );
  }

  async getResolvedEvents(fromBlock: bigint, toBlock: bigint) {
    return this.resolvedEvents.filter(
      (event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock
    );
  }

  async slaCount() {
    return BigInt(this.slas.size);
  }

  async getSla(slaId: bigint) {
    const sla = this.slas.get(slaId);
    if (!sla) {
      throw new Error(`unknown SLA ${slaId.toString()}`);
    }
    return {
      agentA: sla.agentA,
      agentB: sla.agentB,
      targetAddress: sla.targetAddress,
      targetAmount: sla.targetAmount,
      targetBlock: sla.targetBlock,
      collateral: sla.collateral,
      resolved: sla.resolved,
    };
  }

  async status(slaId: bigint) {
    const sla = this.slas.get(slaId);
    if (!sla) {
      throw new Error(`unknown SLA ${slaId.toString()}`);
    }
    return {
      status: sla.status,
      currentBalance: sla.currentBalance,
      blocksRemaining: sla.blocksRemaining,
    };
  }

  resolveSla(slaId: bigint, txHash: Hex) {
    const sla = this.slas.get(slaId);
    if (!sla) {
      throw new Error(`unknown SLA ${slaId.toString()}`);
    }
    if (sla.resolved) {
      throw new Error("already resolved");
    }

    sla.resolved = true;
    sla.status = sla.currentBalance >= sla.targetAmount ? "met" : "slashed";
    sla.blocksRemaining = 0n;

    this.resolvedEvents.push({
      blockNumber: this.currentBlock,
      args: {
        slaId,
        met: sla.status === "met",
        recipient: sla.status === "met" ? sla.agentA : sla.agentB,
        collateral: sla.collateral,
        observedBalance: sla.currentBalance,
        resolvedAtBlock: this.currentBlock,
      },
      transactionHash: txHash,
    });
  }
}

class FakeVerdictService {
  failCount = 0;
  txNonce = 0;

  constructor(private readonly sdk: FakeVerdictSdk) {}

  async resolve(slaId: bigint) {
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error("transient broadcast failure");
    }

    this.txNonce += 1;
    const txHash = `0x${this.txNonce.toString(16).padStart(64, "0")}` as Hex;
    this.sdk.resolveSla(slaId, txHash);
    return {
      txHash,
      tracking: { txHash, status: "confirmed" as const },
    };
  }
}

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-resolver-"));
  const filePath = path.join(tempDir, "state.json");
  const sdk = new FakeVerdictSdk();
  const service = new FakeVerdictService(sdk);
  const store = new FileResolverStore(
    filePath,
    1952,
    "0x00000000000000000000000000000000000000AA",
    10n
  );

  const orchestrator = new VerdictResolverOrchestrator(
    sdk as unknown as any,
    service as unknown as any,
    "0x00000000000000000000000000000000000000BB",
    store,
    {
      actorId: "test-runner",
      maxJobsPerCycle: 10,
      confirmationBufferBlocks: 1n,
      retryBaseMs: 1,
      maxAttempts: 2,
      indexChunkSize: 1000n,
      logSignal: false,
      triggerX402Settlement: false,
    }
  );

  return { sdk, service, store, orchestrator, tempDir };
}

function addRegisteredEvent(sdk: FakeVerdictSdk, slaId: bigint, blockNumber: bigint, overrides?: Partial<FakeSla>) {
  const sla: FakeSla = {
    agentA: "0x0000000000000000000000000000000000000001",
    agentB: "0x0000000000000000000000000000000000000002",
    targetAddress: "0x0000000000000000000000000000000000000003",
    targetAmount: 100n,
    targetBlock: 20n,
    collateral: 50n,
    resolved: false,
    status: "pending",
    currentBalance: 0n,
    blocksRemaining: 0n,
    ...overrides,
  };
  sdk.slas.set(slaId, sla);
  sdk.registeredEvents.push({
    blockNumber,
    args: {
      slaId,
      agentA: sla.agentA,
      agentB: sla.agentB,
      targetAddress: sla.targetAddress,
      targetAmount: sla.targetAmount,
      targetBlock: sla.targetBlock,
      collateral: sla.collateral,
    },
  });
}

test("resolver indexes events and resolves expired SLAs", async () => {
  const { sdk, orchestrator, store, tempDir } = createHarness();
  try {
    sdk.currentBlock = 25n;
    addRegisteredEvent(sdk, 1n, 12n, {
      targetBlock: 20n,
      currentBalance: 100n,
      blocksRemaining: 0n,
    });

    const summary = await orchestrator.runCycle();
    const state = await store.load();

    assert.equal(summary.reconciledSlas, 1);
    assert.equal(summary.confirmedJobs, 1);
    assert.equal(state.slas["1"].status, "met");
    assert.equal(state.jobs["1"].status, "confirmed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver retries transient failures before succeeding", async () => {
  const { sdk, service, orchestrator, store, tempDir } = createHarness();
  try {
    sdk.currentBlock = 30n;
    addRegisteredEvent(sdk, 1n, 12n, {
      targetBlock: 20n,
      currentBalance: 0n,
      blocksRemaining: 0n,
    });
    service.failCount = 1;

    const first = await orchestrator.runCycle();
    const afterFirst = await store.load();
    assert.equal(first.retriedJobs, 1);
    assert.equal(afterFirst.jobs["1"].status, "retrying");

    const second = await orchestrator.runCycle();
    const afterSecond = await store.load();
    assert.equal(second.confirmedJobs, 1);
    assert.equal(afterSecond.slas["1"].status, "slashed");
    assert.equal(afterSecond.jobs["1"].status, "confirmed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver dead-letters jobs after max attempts", async () => {
  const { sdk, service, orchestrator, store, tempDir } = createHarness();
  try {
    sdk.currentBlock = 30n;
    addRegisteredEvent(sdk, 1n, 12n, {
      targetBlock: 20n,
      currentBalance: 0n,
      blocksRemaining: 0n,
    });
    service.failCount = 3;

    await orchestrator.runCycle();
    const second = await orchestrator.runCycle();
    const state = await store.load();

    assert.equal(second.deadLetters, 1);
    assert.equal(state.jobs["1"].status, "dead_letter");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolver reconciliation backfills SLAs even when events are missing", async () => {
  const { sdk, orchestrator, store, tempDir } = createHarness();
  try {
    sdk.currentBlock = 18n;
    sdk.slas.set(1n, {
      agentA: "0x0000000000000000000000000000000000000001",
      agentB: "0x0000000000000000000000000000000000000002",
      targetAddress: "0x0000000000000000000000000000000000000003",
      targetAmount: 100n,
      targetBlock: 20n,
      collateral: 50n,
      resolved: false,
      status: "pending",
      currentBalance: 0n,
      blocksRemaining: 2n,
    });

    const summary = await orchestrator.runCycle();
    const state = await store.load();

    assert.equal(summary.reconciledSlas, 1);
    assert.equal(state.slas["1"].slaId, "1");
    assert.equal(state.slas["1"].indexedFromEvent, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
