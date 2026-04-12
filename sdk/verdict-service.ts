import type { Address, Hex } from "viem";

import { VerdictSdk, type VerdictRegisterInput } from "./verdict-sdk";
import type { OnchainOsSkillAdapter, X402SettlementReceipt } from "./onchainos-adapter";

export type RegisterExecutionResult = {
  simulation: "ok";
  txHash: Hex;
  approvalTxHashes: Hex[];
};

export type ResolveExecutionResult = {
  txHash: Hex;
  tracking: { txHash: Hex; status: "pending" | "confirmed" | "failed" };
  settlement?: X402SettlementReceipt;
};

/**
 * VerdictService wires the deterministic contract wrapper to the exact
 * Onchain OS skill flow described in the hackathon brief.
 */
export class VerdictService {
  constructor(
    private readonly verdict: VerdictSdk,
    private readonly skills: OnchainOsSkillAdapter
  ) {}

  async register(input: VerdictRegisterInput, tokenSymbol?: string): Promise<RegisterExecutionResult> {
    const tokenCheck = await this.skills.dexToken.validateTargetToken({
      token: this.verdict.settlementToken,
      expectedSymbol: tokenSymbol,
    });

    if (!tokenCheck.accepted) {
      throw new Error(tokenCheck.reason ?? "Target token rejected by okx-dex-token");
    }

    await this.skills.walletPortfolio.assertCollateralBalance({
      owner: input.agentA,
      token: this.verdict.settlementToken,
      minimum: input.collateral,
    });

    const approvalTxHashes: Hex[] = [];
    let allowance = await this.verdict.getTokenAllowance(input.agentA, this.verdict.contractAddress);

    if (allowance < input.collateral) {
      if (allowance > 0n) {
        const resetApprovalTxHash = await this.approveCollateral(input.agentA, 0n);
        approvalTxHashes.push(resetApprovalTxHash);
      }

      const approveTxHash = await this.approveCollateral(input.agentA, input.collateral);
      approvalTxHashes.push(approveTxHash);
      allowance = await this.verdict.getTokenAllowance(input.agentA, this.verdict.contractAddress);
    }

    if (allowance < input.collateral) {
      throw new Error("Collateral allowance is still below the required amount after approval");
    }

    const calldata = this.verdict.encodeRegisterCalldata(input);

    await this.skills.onchainGateway.simulateContractCall({
      to: this.verdict.contractAddress,
      from: input.agentA,
      data: calldata,
      value: 0n,
    });

    const { txHash } = await this.skills.onchainGateway.broadcastContractCall({
      label: "register",
      to: this.verdict.contractAddress,
      from: input.agentA,
      data: calldata,
      value: 0n,
    });

    return {
      simulation: "ok",
      txHash,
      approvalTxHashes,
    };
  }

  /**
   * For the current contract, resolution uses settlement-token balance only.
   * A future value-based SLA template can consult okx-dex-market before choosing
   * which contract variant to instantiate, without changing the deterministic core.
   */
  async resolve(
    slaId: bigint,
    executor: Address,
    opts?: { logSignal?: boolean; triggerX402Settlement?: boolean }
  ): Promise<ResolveExecutionResult> {
    const sla = await this.verdict.getSla(slaId);

    const calldata = this.verdict.encodeResolveCalldata(slaId);

    await this.skills.onchainGateway.simulateContractCall({
      to: this.verdict.contractAddress,
      from: executor,
      data: calldata,
      value: 0n,
    });

    const { txHash } = await this.skills.onchainGateway.broadcastContractCall({
      label: "resolve",
      to: this.verdict.contractAddress,
      from: executor,
      data: calldata,
      value: 0n,
    });

    const tracking = await this.skills.onchainGateway.trackTransaction(txHash);
    if (tracking.status !== "confirmed") {
      return {
        txHash,
        tracking,
      };
    }

    const postStatus = await this.verdict.status(slaId);
    const outcome = postStatus.status === "met" ? "met" : "slashed";
    const recipient = outcome === "met" ? (sla.agentA as Address) : (sla.agentB as Address);

    let settlement: X402SettlementReceipt | undefined;
    if (opts?.triggerX402Settlement && this.skills.x402) {
      settlement = await this.skills.x402.settle({
        recipient,
        amount: sla.collateral,
        slaId,
        outcome,
      });
    }

    if (opts?.logSignal && this.skills.dexSignal) {
      await this.skills.dexSignal.logResolution({
        slaId,
        agentA: sla.agentA as Address,
        agentB: sla.agentB as Address,
        outcome,
        txHash,
      });
    }

    return {
      txHash,
      tracking,
      settlement,
    };
  }

  private async approveCollateral(owner: Address, amount: bigint): Promise<Hex> {
    const approveCalldata = this.verdict.encodeApproveCalldata(this.verdict.contractAddress, amount);

    await this.skills.onchainGateway.simulateContractCall({
      to: this.verdict.settlementToken,
      from: owner,
      data: approveCalldata,
      value: 0n,
    });

    const { txHash } = await this.skills.onchainGateway.broadcastContractCall({
      label: "approve",
      to: this.verdict.settlementToken,
      from: owner,
      data: approveCalldata,
      value: 0n,
    });

    const tracking = await this.skills.onchainGateway.trackTransaction(txHash);
    if (tracking.status !== "confirmed") {
      throw new Error(`Approval transaction ${txHash} did not confirm successfully`);
    }

    return txHash;
  }
}
