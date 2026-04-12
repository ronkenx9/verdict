import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import type { Address, Chain, Hex, PublicClient, WalletClient } from "viem";
import type { OnchainOsSkillAdapter } from "./onchainos-adapter";

type VerdictStatus = "pending" | "met" | "slashed";

export type VerdictRegisterInput = {
  agentA: Address;
  agentB: Address;
  targetAddress: Address;
  targetAmount: bigint;
  targetBlock: bigint;
  collateral: bigint;
};

export type VerdictStatusResult = {
  status: VerdictStatus;
  blocksRemaining: bigint;
  currentBalance: bigint;
};

export type VerdictWriteResult = {
  txHash: Hex;
  orderId: string;
  preflightChecks: {
    balanceSufficient: boolean;
    tokenValid: boolean;
    simulationPassed: boolean;
  };
  settlement?: {
    x402Receipt: string;
    signalLogged: boolean;
  };
};

export type VerdictSdkConfig = {
  contractAddress: Address;
  settlementToken: Address;
  chain: Chain;
  rpcUrl: string;
  walletClient?: WalletClient;
  publicClient?: PublicClient;
  /** OnchainOS adapter — required for production; omit only in dev/test mode */
  adapter?: OnchainOsSkillAdapter;
};

export const verdictAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "payable",
    inputs: [
      {
        name: "sla",
        type: "tuple",
        components: [
          { name: "agentA", type: "address" },
          { name: "agentB", type: "address" },
          { name: "targetAddress", type: "address" },
          { name: "targetAmount", type: "uint256" },
          { name: "targetBlock", type: "uint256" },
          { name: "collateral", type: "uint256" },
          { name: "resolved", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "slaId", type: "uint256" }],
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [{ name: "slaId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "status",
    stateMutability: "view",
    inputs: [{ name: "slaId", type: "uint256" }],
    outputs: [
      { name: "lifecycle", type: "string" },
      { name: "blocksRemaining", type: "uint256" },
      { name: "currentBalance", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "slaCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getSLA",
    stateMutability: "view",
    inputs: [{ name: "slaId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentA", type: "address" },
          { name: "agentB", type: "address" },
          { name: "targetAddress", type: "address" },
          { name: "targetAmount", type: "uint256" },
          { name: "targetBlock", type: "uint256" },
          { name: "collateral", type: "uint256" },
          { name: "resolved", type: "bool" },
        ],
      },
    ],
  },
] as const;

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const verdictEventsAbi = parseAbi([
  "event SLARegistered(uint256 indexed slaId, address indexed agentA, address indexed agentB, address targetAddress, uint256 targetAmount, uint256 targetBlock, uint256 collateral)",
  "event SLAResolved(uint256 indexed slaId, bool met, address indexed recipient, uint256 collateral, uint256 observedBalance, uint256 resolvedAtBlock)",
]);

const slaRegisteredEvent = verdictEventsAbi[0];
const slaResolvedEvent = verdictEventsAbi[1];

/**
 * VERDICT SDK
 *
 * This wrapper is intentionally deterministic around the contract calls:
 * - preflight validation belongs to Onchain OS skills
 * - enforcement belongs to VerdictCore
 * - settlement stays onchain in a single resolve() transaction
 */
export class VerdictSdk {
  readonly contractAddress: Address;
  readonly settlementToken: Address;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly adapter?: OnchainOsSkillAdapter;
  private readonly config: VerdictSdkConfig;

  constructor(config: VerdictSdkConfig) {
    this.config = config;
    this.contractAddress = config.contractAddress;
    this.settlementToken = config.settlementToken;
    this.publicClient =
      config.publicClient ??
      createPublicClient({
        chain: config.chain,
        transport: http(config.rpcUrl),
      });
    this.walletClient = config.walletClient;
    this.adapter = config.adapter;
  }

  /**
   * Onchain OS mapping:
   * - okx-wallet-portfolio: verify agentA can actually post collateral (step 1)
   * - okx-dex-token: validate target asset / reject toxic tokens preflight (step 2)
   * - okx-onchain-gateway: simulate approve + register (step 3), track finality (step 6)
   */
  async register(input: VerdictRegisterInput): Promise<VerdictWriteResult> {
    this.assertWalletClient("register");

    const preflightChecks = {
      balanceSufficient: false,
      tokenValid: false,
      simulationPassed: false,
    };

    if (!this.adapter) {
      // Dev mode: bypass OnchainOS checks and write directly
      console.warn("[verdict-sdk] adapter not configured — writing directly (dev mode only)");
      const txHash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: verdictAbi,
        functionName: "register",
        args: [{ ...input, resolved: false }],
        account: input.agentA,
        chain: this.publicClient.chain,
      });
      return { txHash, orderId: txHash, preflightChecks };
    }

    // Step 1: Portfolio check — agentA must hold enough to cover collateral
    await this.adapter.walletPortfolio.assertCollateralBalance({
      owner: input.agentA,
      token: this.settlementToken,
      minimum: input.collateral,
    });
    preflightChecks.balanceSufficient = true;

    // Step 2: Token validation — settlementToken must be legitimate
    const tokenCheck = await this.adapter.dexToken.validateTargetToken({ token: this.settlementToken });
    if (!tokenCheck.accepted) {
      throw new Error(`[verdict-sdk] Token validation failed: ${tokenCheck.reason ?? "rejected by OKX dex-token"}`);
    }
    preflightChecks.tokenValid = true;

    // Step 3: Simulate approve tx
    const approveData = this.encodeApproveCalldata(this.contractAddress, input.collateral);
    await this.adapter.onchainGateway.simulateContractCall({
      from: input.agentA,
      to: this.settlementToken,
      data: approveData,
    });

    // Step 3 (cont): Simulate register tx
    const registerData = this.encodeRegisterCalldata(input);
    await this.adapter.onchainGateway.simulateContractCall({
      from: input.agentA,
      to: this.contractAddress,
      data: registerData,
    });
    preflightChecks.simulationPassed = true;

    // Step 4: Sign approve tx locally and broadcast via viem
    const approveRequest = await this.publicClient.simulateContract({
      address: this.settlementToken,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.contractAddress, input.collateral],
      account: input.agentA,
    });
    const signedApproveTx = await this.walletClient.writeContract(approveRequest.request);

    // Step 6: Track approve tx finality
    await this.adapter.onchainGateway.trackTransaction(signedApproveTx);

    // Step 4: Sign register tx locally
    const registerRequest = await this.publicClient.simulateContract({
      address: this.contractAddress,
      abi: verdictAbi,
      functionName: "register",
      args: [{ ...input, resolved: false }],
      account: input.agentA,
    });
    const txHash = await this.walletClient.writeContract(registerRequest.request);

    // Step 6: Track register tx finality
    const tracked = await this.adapter.onchainGateway.trackTransaction(txHash);
    if (tracked.status === "failed") {
      throw new Error(`[verdict-sdk] register tx ${txHash} failed on-chain`);
    }

    return { txHash, orderId: txHash, preflightChecks };
  }

  /**
   * Onchain OS mapping:
   * - okx-onchain-gateway: simulate resolve() (step 3), track finality (step 6)
   * - x402 settlement rail: downstream settlement accounting / instant agent-native payout flows (step 7)
   * - okx-dex-signal: emit reputation signal after resolution (step 8)
   */
  async resolve(slaId: bigint, account?: Address): Promise<VerdictWriteResult> {
    this.assertWalletClient("resolve");
    const resolvedAccount = account ?? (this.walletClient.account as Address | undefined) ?? null;
    if (!resolvedAccount) {
      throw new Error("VerdictSdk resolve requires an explicit account or a wallet client with a default account");
    }

    const preflightChecks = {
      balanceSufficient: true,    // resolve() has no token transfer requirement
      tokenValid: true,
      simulationPassed: false,
    };

    if (!this.adapter) {
      // Dev mode: write directly
      console.warn("[verdict-sdk] adapter not configured — resolving directly (dev mode only)");
      const txHash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: verdictAbi,
        functionName: "resolve",
        args: [slaId],
        account: resolvedAccount,
        chain: this.publicClient.chain,
      });
      return { txHash, orderId: txHash, preflightChecks };
    }

    // Step 3: Simulate resolve tx
    const resolveData = this.encodeResolveCalldata(slaId);
    await this.adapter.onchainGateway.simulateContractCall({
      from: resolvedAccount,
      to: this.contractAddress,
      data: resolveData,
    });
    preflightChecks.simulationPassed = true;

    // Step 4: Sign resolve tx locally
    const resolveRequest = await this.publicClient.simulateContract({
      address: this.contractAddress,
      abi: verdictAbi,
      functionName: "resolve",
      args: [slaId],
      account: resolvedAccount,
    });
    const txHash = await this.walletClient.writeContract(resolveRequest.request);

    // Step 6: Track finality
    const tracked = await this.adapter.onchainGateway.trackTransaction(txHash);
    if (tracked.status === "failed") {
      throw new Error(`[verdict-sdk] resolve tx ${txHash} failed on-chain`);
    }

    // Step 7: x402 settlement (resolve only)
    let x402Receipt = "";
    let signalLogged = false;
    const sla = await this.getSla(slaId);
    const postStatus = await this.status(slaId);
    const outcome = postStatus.status === "met" ? "met" : "slashed";
    const met = outcome === "met";

    if (this.adapter.x402) {
      const receipt = await this.adapter.x402.settle({
        recipient: met ? sla.agentA : sla.agentB,
        amount: sla.collateral,
        slaId,
        outcome,
      });
      x402Receipt = receipt.reference;
    }

    // Step 8: dex-signal reputation emit (resolve only)
    if (this.adapter.dexSignal) {
      await this.adapter.dexSignal.logResolution({
        slaId,
        agentA: sla.agentA,
        agentB: sla.agentB,
        outcome: met ? "met" : "slashed",
        txHash,
      });
      signalLogged = true;
    }

    return {
      txHash,
      orderId: txHash,
      preflightChecks,
      settlement: { x402Receipt, signalLogged },
    };
  }

  async status(slaId: bigint): Promise<VerdictStatusResult> {
    const [status, blocksRemaining, currentBalance] = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: verdictAbi,
      functionName: "status",
      args: [slaId],
    });
    return {
      status: status as VerdictStatus,
      blocksRemaining,
      currentBalance,
    };
  }

  async getSla(slaId: bigint) {
    return this.publicClient.readContract({
      address: this.contractAddress,
      abi: verdictAbi,
      functionName: "getSLA",
      args: [slaId],
    });
  }

  async slaCount() {
    return this.publicClient.readContract({
      address: this.contractAddress,
      abi: verdictAbi,
      functionName: "slaCount",
    });
  }

  async getBlockNumber() {
    return this.publicClient.getBlockNumber();
  }

  async getTokenAllowance(owner: Address, spender: Address) {
    return this.publicClient.readContract({
      address: this.settlementToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
  }

  /**
   * Helper for Onchain OS / gateway integrations that need calldata
   * for simulation, policy checks, or custom broadcast paths.
   */
  encodeRegisterCalldata(input: VerdictRegisterInput) {
    return encodeFunctionData({
      abi: verdictAbi,
      functionName: "register",
      args: [
        {
          ...input,
          resolved: false,
        },
      ],
    });
  }

  encodeResolveCalldata(slaId: bigint) {
    return encodeFunctionData({
      abi: verdictAbi,
      functionName: "resolve",
      args: [slaId],
    });
  }

  encodeApproveCalldata(spender: Address, amount: bigint) {
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    });
  }

  async getRegisteredEvents(fromBlock: bigint, toBlock: bigint) {
    return this.publicClient.getLogs({
      address: this.contractAddress,
      event: slaRegisteredEvent,
      fromBlock,
      toBlock,
      strict: true,
    });
  }

  async getResolvedEvents(fromBlock: bigint, toBlock: bigint) {
    return this.publicClient.getLogs({
      address: this.contractAddress,
      event: slaResolvedEvent,
      fromBlock,
      toBlock,
      strict: true,
    });
  }

  private assertWalletClient(action: string): asserts this is VerdictSdk & { walletClient: WalletClient } {
    if (!this.walletClient) {
      throw new Error(`VerdictSdk cannot ${action} without a wallet client`);
    }
  }
}

/**
 * Hackathon-facing shape:
 *
 * verdict.register({
 *   agentA: "0x...",
 *   agentB: "0x...",
 *   targetAddress: "0x...",
 *   targetAmount: 1000000n,
 *   targetBlock: 15000n,
 *   collateral: 500000n
 * })
 *
 * verdict.resolve(1n)
 * verdict.status(1n)
 */
