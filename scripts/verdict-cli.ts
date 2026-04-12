import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { Command } from "commander";
import dotenv from "dotenv";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, defineChain, formatUnits, getAddress, http, parseAbi, parseUnits } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createOnchainOsAdapterFromEnv,
  createOnchainOsSkillAdapter,
  type OnchainOsSkillAdapter,
} from "../sdk/onchainos-adapter";
import { PostgresHaResolver } from "../sdk/resolver/postgres-ha";
import { VerdictResolverOrchestrator } from "../sdk/resolver/orchestrator";
import { PostgresResolverStore } from "../sdk/resolver/postgres-store";
import { FileResolverStore } from "../sdk/resolver/store";
import { VerdictSdk } from "../sdk/verdict-sdk";
import { VerdictService } from "../sdk/verdict-service";

dotenv.config({ path: path.join(process.cwd(), ".env") });

if (!process.env.OKX_API_KEY && process.env.ONCHAINOS_API_KEY) {
  process.env.OKX_API_KEY = process.env.ONCHAINOS_API_KEY;
}
if (!process.env.OKX_SECRET_KEY && process.env.ONCHAINOS_SECRET_KEY) {
  process.env.OKX_SECRET_KEY = process.env.ONCHAINOS_SECRET_KEY;
}
if (!process.env.OKX_PASSPHRASE && process.env.ONCHAINOS_PASSPHRASE) {
  process.env.OKX_PASSPHRASE = process.env.ONCHAINOS_PASSPHRASE;
}

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

function getChain() {
  const network = process.env.VERDICT_NETWORK ?? "xlayer_testnet";
  if (network === "xlayer_mainnet") {
    return defineChain({
      id: 196,
      name: "X Layer",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: {
        default: { http: [process.env.VERDICT_RPC_URL ?? "https://rpc.xlayer.tech"] },
      },
      blockExplorers: {
        default: { name: "OKLink", url: "https://www.oklink.com/xlayer" },
      },
    });
  }

  return defineChain({
    id: 1952,
    name: "X Layer Testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: {
      default: { http: [process.env.VERDICT_RPC_URL ?? "https://testrpc.xlayer.tech"] },
    },
    blockExplorers: {
      default: { name: "OKLink", url: "https://www.oklink.com/xlayer-test" },
    },
  });
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value || value.includes("REPLACE_WITH")) {
    throw new Error(`Missing or placeholder env var: ${name}`);
  }
  return value;
}

function resolveContractAddress() {
  const fromEnv = process.env.VERDICT_CORE_ADDRESS;
  if (fromEnv && !fromEnv.includes("REPLACE_WITH")) {
    return getAddress(fromEnv);
  }

  const deploymentsPath = path.join(process.cwd(), "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error("VERDICT_CORE_ADDRESS not set and deployments.json not found");
  }

  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const record = deployments[process.env.VERDICT_NETWORK ?? "xlayer_testnet"];
  if (!record?.address) {
    throw new Error("No deployment record for selected VERDICT_NETWORK");
  }

  return getAddress(record.address);
}

function resolveDeploymentRecord() {
  const deploymentsPath = path.join(process.cwd(), "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    return null;
  }

  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  return deployments[process.env.VERDICT_NETWORK ?? "xlayer_testnet"] ?? null;
}

function resolveSettlementToken() {
  const network = process.env.VERDICT_NETWORK ?? "xlayer_testnet";
  const value =
    network === "xlayer_mainnet"
      ? requireEnv("USDC_ADDRESS_MAINNET")
      : requireEnv("USDC_ADDRESS_TESTNET");
  return getAddress(value);
}

function resolveDeploymentBlock() {
  const record = resolveDeploymentRecord();
  if (record?.blockNumber) {
    return BigInt(record.blockNumber);
  }

  const configured = process.env.VERDICT_DEPLOYMENT_BLOCK;
  if (configured) {
    return BigInt(configured);
  }

  return 0n;
}

function getOperatorMode() {
  return process.env.VERDICT_OPERATOR_MODE ?? "onchainos";
}

function isSupportedOnchainOsChain(chainId: number) {
  return chainId === 196;
}

function resolveOperatorAddress() {
  return getAddress(requireEnv("XLAYER_WALLET_ADDRESS"));
}

function tryParseJson<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function extractTxHash(output: string): Hex {
  const directJson = tryParseJson<{ txHash?: string; data?: { txHash?: string } }>(output);
  const candidate = directJson?.txHash ?? directJson?.data?.txHash;
  if (candidate && /^0x[a-fA-F0-9]{64}$/.test(candidate)) {
    return candidate as Hex;
  }

  const match = output.match(/0x[a-fA-F0-9]{64}/);
  if (!match) {
    throw new Error(`Unable to extract tx hash from onchainos output:\n${output}`);
  }

  return match[0] as Hex;
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function stringifyCli(value: unknown) {
  return JSON.stringify(
    value,
    (_key, nestedValue) => (typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue),
    2
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trackTransactionWithTimeout(publicClient: PublicClient, txHash: Hex) {
  const timeoutMs = Number(process.env.VERDICT_TX_TRACK_TIMEOUT_MS ?? "120000");
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: timeoutMs,
    });
    return {
      txHash,
      status: receipt.status === "success" ? "confirmed" : "failed",
    } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("timed out") || message.includes("timeout")) {
      return {
        txHash,
        status: "pending",
      } as const;
    }
    throw error;
  }
}

function acquireProcessLock(lockPath: string) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let handle: number;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Resolver lock already exists at ${lockPath}. Another resolver process may already be running.`);
    }
    throw error;
  }

  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2));

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      fs.closeSync(handle);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  };

  return release;
}

function runOnchainos(args: string[]) {
  try {
    return execFileSync("onchainos", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    try {
      const bashCommand = `source ~/.bashrc >/dev/null 2>&1; onchainos ${args.map(shellEscape).join(" ")}`;
      return execFileSync("bash", ["-lc", bashCommand], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (fallbackError) {
      const primaryMessage =
        error instanceof Error && "message" in error
          ? error.message
          : "Unknown direct execution error";
      const fallbackMessage =
        fallbackError instanceof Error && "message" in fallbackError
          ? fallbackError.message
          : "Unknown bash fallback error";
      throw new Error(
        `OnchainOS CLI execution failed.\nDirect execution: ${primaryMessage}\nBash fallback: ${fallbackMessage}\nMake sure the CLI is installed and your Agentic Wallet session is logged in.`
      );
    }
  }
}

function buildRuntime() {
  const chain = getChain();
  const rpcUrl = requireEnv("VERDICT_RPC_URL");
  const contractAddress = resolveContractAddress();
  const settlementToken = resolveSettlementToken();
  const operatorMode = getOperatorMode();

  if (operatorMode === "onchainos" && !isSupportedOnchainOsChain(chain.id)) {
    throw new Error(
      `${chain.name} (${chain.id}) is not supported by onchainos wallet contract-call. ` +
        "Use VERDICT_OPERATOR_MODE=private_key for testnet execution."
    );
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  let accountAddress: Address;
  let signerAccount: ReturnType<typeof privateKeyToAccount> | undefined;
  let walletClient: WalletClient | undefined;

  if (operatorMode === "private_key") {
    const privateKey = `0x${requireEnv("PRIVATE_KEY").replace(/^0x/, "")}` as const;
    signerAccount = privateKeyToAccount(privateKey);
    accountAddress = signerAccount.address;
    walletClient = createWalletClient({
      account: signerAccount,
      chain,
      transport: http(rpcUrl),
    });
  } else {
    accountAddress = resolveOperatorAddress();
  }

  const verdictSdk = new VerdictSdk({
    contractAddress,
    settlementToken,
    chain,
    rpcUrl,
    publicClient,
    walletClient,
  });

  // Shared helper: check ERC-20 balance against a minimum, throw if insufficient
  async function localAssertBalance(owner: Address, token: Address, minimum: bigint, label: string) {
    const balance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
    if (balance < minimum) {
      let decimals = 18;
      try {
        decimals = Number(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
      } catch {}
      throw new Error(
        `[${label}] Insufficient balance: ${formatUnits(balance, decimals)} available, ${formatUnits(minimum, decimals)} required`
      );
    }
  }

  // Shared helper: validate token contract exists and has expected symbol
  async function localValidateToken(token: Address): Promise<{ valid: boolean; symbol: string; decimals: number; reason?: string }> {
    const code = await publicClient.getBytecode({ address: token });
    if (!code || code === "0x") return { valid: false, symbol: "", decimals: 0, reason: "Token contract not found on-chain" };
    try {
      const [symbol, decimals] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
      ]);
      return { valid: true, symbol, decimals: Number(decimals) };
    } catch {
      return { valid: false, symbol: "", decimals: 0, reason: "Unable to read token metadata" };
    }
  }

  const privateKeyAdapter = createOnchainOsSkillAdapter({
    walletPortfolio: {
      assertBalance: localAssertBalance,
    },
    onchainGateway: {
      async simulate(from, to, data) {
        await publicClient.call({ account: from, to, data });
        return { gasEstimate: 0n, willSucceed: true };
      },
      async broadcast(_signedTx) {
        throw new Error("[verdict-cli] broadcast() should not be called in private_key mode — walletClient handles signing directly");
      },
      async track(orderId) {
        // local mode: treat orderId as txHash when available, otherwise confirm immediately
        return { status: "confirmed", txHash: orderId as Hex };
      },
    },
    dexToken: {
      validate: localValidateToken,
    },
    dexSignal: {
      async logOutcome(slaId, _agentA, _agentB, outcome, txHash) {
        console.log(`[signal] SLA ${slaId} → ${outcome} (${txHash})`);
      },
    },
    x402: {
      async settle(recipient, amount, _token, reference) {
        return { receipt: `x402-local:${reference}:${recipient}:${amount}`, settled: true };
      },
    },
    dexMarket: {
      async getPrice(_token) { return { priceUsd: 1, symbol: "USDC" }; },
      async usdToTokenUnits(usdAmount, _token, decimals) { return BigInt(Math.ceil(usdAmount * 10 ** decimals)); },
    },
    uniswap: {
      async getQuote(_tokenIn, _tokenOut, amountOut, _chainId) {
        return { amountIn: amountOut, priceImpact: 0, route: "direct" };
      },
      async getPrice(_token) { return { priceUsd: 1 }; },
    },
  });

  let onchainOsAdapter: OnchainOsSkillAdapter;
  try {
    const liveAdapter = createOnchainOsAdapterFromEnv();
    onchainOsAdapter = {
      walletPortfolio: {
        async assertCollateralBalance({ owner, token, minimum }) {
          await liveAdapter.walletPortfolio.assertBalance(owner, token, minimum, "collateral-check");
        },
      },
      onchainGateway: {
        async simulateContractCall({ from, to, data }) {
          await publicClient.call({ account: from, to, data });
        },
        async broadcastContractCall({ from, to, data, value }) {
          const args = [
            "wallet",
            "contract-call",
            "--to",
            to,
            "--chain",
            String(chain.id),
            "--input-data",
            data,
            "--amt",
            (value ?? 0n).toString(),
            "--from",
            from,
          ];
          const output = runOnchainos(args);
          return { txHash: extractTxHash(output) };
        },
        async trackTransaction(txHash) {
          return trackTransactionWithTimeout(publicClient, txHash);
        },
      },
      dexToken: {
        async validateTargetToken({ token }) {
          try {
            const result = await liveAdapter.dexToken.validate(token);
            return { accepted: result.valid, reason: result.reason };
          } catch (error) {
            return {
              accepted: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        },
      },
      dexMarket: {
        async getSpotPrice({ baseToken }) {
          const { priceUsd } = await liveAdapter.dexMarket.getPrice(baseToken);
          return { price: BigInt(Math.round(priceUsd * 1e18)) };
        },
      },
      dexSignal: {
        async logResolution({ slaId, agentA, agentB, outcome, txHash }) {
          await liveAdapter.dexSignal.logOutcome(slaId, agentA, agentB, outcome, txHash);
        },
      },
      x402: {
        async settle({ recipient, amount, slaId, outcome }) {
          const zeroToken = "0x0000000000000000000000000000000000000000" as Address;
          const reference = `sla-${slaId.toString()}-${outcome}`;
          const result = await liveAdapter.x402.settle(recipient, amount, zeroToken, reference);
          return {
            rail: "x402",
            status: result.settled ? "settled" : "queued",
            reference: result.receipt,
          };
        },
      },
      uniswap: {
        async getQuote({ tokenIn, tokenOut, amountOut, chainId }) {
          const result = await liveAdapter.uniswap.getQuote(tokenIn, tokenOut, amountOut, chainId);
          return {
            amountIn: result.amountIn,
            priceImpact: result.priceImpact,
            route: result.route.split(" -> "),
          };
        },
      },
    };
  } catch {
    onchainOsAdapter = createOnchainOsSkillAdapter({
    walletPortfolio: {
      assertBalance: localAssertBalance,
    },
    onchainGateway: {
      async simulate(from, to, data) {
        await publicClient.call({ account: from, to, data });
        return { gasEstimate: 0n, willSucceed: true };
      },
      async broadcast(_signedTx) {
        const output = runOnchainos(["wallet", "broadcast", "--signed-tx", JSON.stringify(_signedTx)]);
        const txHash = extractTxHash(output);
        return { orderId: txHash, txHash };
      },
      async track(orderId) {
        return { status: "confirmed", txHash: orderId as Hex };
      },
    },
    dexToken: {
      validate: localValidateToken,
    },
    dexSignal: {
      async logOutcome(slaId, _agentA, _agentB, outcome, txHash) {
        console.log(`[signal] SLA ${slaId} → ${outcome} (${txHash})`);
      },
    },
    x402: {
      async settle(recipient, amount, _token, reference) {
        return { receipt: `x402-onchainos:${reference}:${recipient}:${amount}`, settled: true };
      },
    },
    dexMarket: {
      async getPrice(_token) { return { priceUsd: 1, symbol: "USDC" }; },
      async usdToTokenUnits(usdAmount, _token, decimals) { return BigInt(Math.ceil(usdAmount * 10 ** decimals)); },
    },
    uniswap: {
      async getQuote(_tokenIn, _tokenOut, amountOut, _chainId) {
        return { amountIn: amountOut, priceImpact: 0, route: "direct" };
      },
      async getPrice(_token) { return { priceUsd: 1 }; },
    },
    });
  }

  const adapter = operatorMode === "private_key" ? privateKeyAdapter : onchainOsAdapter;

  const service = new VerdictService(verdictSdk, adapter);

  return {
    account: { address: accountAddress },
    chain,
    settlementToken,
    contractAddress,
    verdictSdk,
    service,
    operatorMode,
  };
}

function buildResolverRuntime() {
  const runtime = buildRuntime();
  const deploymentBlock = resolveDeploymentBlock();
  const databaseUrl = process.env.VERDICT_RESOLVER_DATABASE_URL;
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
  const statePath =
    process.env.VERDICT_RESOLVER_STATE_PATH ??
    path.join(process.cwd(), "cache", `resolver-state-${runtime.chain.id}.json`);
  const store = databaseUrl
    ? new PostgresResolverStore(
        pool!,
        runtime.chain.id,
        runtime.contractAddress,
        deploymentBlock
      )
    : new FileResolverStore(
        statePath,
        runtime.chain.id,
        runtime.contractAddress,
        deploymentBlock
      );
  const orchestrator = new VerdictResolverOrchestrator(
    runtime.verdictSdk,
    runtime.service,
    runtime.account.address,
    store,
    {
      actorId: `${runtime.operatorMode}:${runtime.account.address.toLowerCase()}`,
      maxJobsPerCycle: Number(process.env.VERDICT_RESOLVER_MAX_JOBS ?? "10"),
      confirmationBufferBlocks: BigInt(process.env.VERDICT_RESOLVER_CONFIRMATION_BUFFER_BLOCKS ?? "1"),
      retryBaseMs: Number(process.env.VERDICT_RESOLVER_RETRY_BASE_MS ?? "30000"),
      maxAttempts: Number(process.env.VERDICT_RESOLVER_MAX_ATTEMPTS ?? "8"),
      indexChunkSize: BigInt(process.env.VERDICT_RESOLVER_INDEX_CHUNK_SIZE ?? "2000"),
      logSignal: process.env.VERDICT_RESOLVER_LOG_SIGNAL === "true",
      triggerX402Settlement: process.env.VERDICT_RESOLVER_X402 === "true",
    }
  );
  const haResolver = databaseUrl
    ? new PostgresHaResolver(
        pool!,
        runtime.verdictSdk,
        runtime.service,
        runtime.account.address,
        runtime.chain.id,
        runtime.contractAddress,
        deploymentBlock,
        {
          actorId: `${runtime.operatorMode}:${runtime.account.address.toLowerCase()}`,
          maxJobsPerCycle: Number(process.env.VERDICT_RESOLVER_MAX_JOBS ?? "10"),
          confirmationBufferBlocks: BigInt(process.env.VERDICT_RESOLVER_CONFIRMATION_BUFFER_BLOCKS ?? "1"),
          retryBaseMs: Number(process.env.VERDICT_RESOLVER_RETRY_BASE_MS ?? "30000"),
          maxAttempts: Number(process.env.VERDICT_RESOLVER_MAX_ATTEMPTS ?? "8"),
          indexChunkSize: BigInt(process.env.VERDICT_RESOLVER_INDEX_CHUNK_SIZE ?? "2000"),
          leaseMs: Number(process.env.VERDICT_RESOLVER_LEASE_MS ?? "180000"),
          logSignal: process.env.VERDICT_RESOLVER_LOG_SIGNAL === "true",
          triggerX402Settlement: process.env.VERDICT_RESOLVER_X402 === "true",
        }
      )
    : undefined;

  return {
    ...runtime,
    deploymentBlock,
    databaseUrl,
    pool,
    statePath,
    store,
    orchestrator,
    haResolver,
  };
}

const program = new Command();
program.name("verdict-cli");

program
  .command("doctor")
  .description("Print runtime information and deployment pointers")
  .action(async () => {
    const runtime = buildRuntime();
    console.log(`network: ${runtime.chain.name}`);
    console.log(`operatorMode: ${runtime.operatorMode}`);
    console.log(`operator: ${runtime.account.address}`);
    console.log(`contract: ${runtime.contractAddress}`);
    console.log(`settlementToken: ${runtime.settlementToken}`);
  });

program
  .command("status")
  .requiredOption("--sla-id <number>", "SLA identifier")
  .action(async (options) => {
    const { verdictSdk } = buildRuntime();
    const slaId = BigInt(options.slaId);
    const count = await verdictSdk.slaCount();
    if (slaId < 1n || slaId > count) {
      console.error(`Unknown SLA ${slaId.toString()}. Current slaCount is ${count.toString()}.`);
      process.exitCode = 1;
      return;
    }
    const result = await verdictSdk.status(slaId);
    console.log(stringifyCli(result));
  });

program
  .command("register")
  .requiredOption("--agent-b <address>", "Counterparty address")
  .requiredOption("--target-address <address>", "Target wallet address")
  .requiredOption("--target-amount <amount>", "Human-readable target amount, e.g. 1")
  .requiredOption("--target-block <number>", "Deadline block number")
  .requiredOption("--collateral <amount>", "Human-readable collateral amount, e.g. 0.5")
  .option("--decimals <number>", "Token decimals", process.env.DEFAULT_TOKEN_DECIMALS ?? "6")
  .action(async (options) => {
    const { service, account } = buildRuntime();
    const decimals = Number(options.decimals);
    const tx = await service.register({
      agentA: account.address,
      agentB: getAddress(options.agentB),
      targetAddress: getAddress(options.targetAddress),
      targetAmount: parseUnits(options.targetAmount, decimals),
      targetBlock: BigInt(options.targetBlock),
      collateral: parseUnits(options.collateral, decimals),
    });
    console.log(stringifyCli(tx));
  });

program
  .command("resolve")
  .requiredOption("--sla-id <number>", "SLA identifier")
  .option("--log-signal", "Log a post-resolution signal")
  .option("--x402", "Trigger x402 settlement receipt generation")
  .action(async (options) => {
    const { service, account } = buildRuntime();
    const result = await service.resolve(BigInt(options.slaId), account.address, {
      logSignal: Boolean(options.logSignal),
      triggerX402Settlement: Boolean(options.x402),
    });
    console.log(stringifyCli(result));
  });

const resolver = program.command("resolver").description("Persistent resolver subsystem for expired SLAs");

resolver
  .command("db:init")
  .description("Initialize the shared Postgres schema used by the resolver")
  .action(async () => {
    const { databaseUrl, haResolver } = buildResolverRuntime();
    if (!databaseUrl || !haResolver) {
      throw new Error("VERDICT_RESOLVER_DATABASE_URL must be set to initialize the shared resolver database");
    }

    await haResolver.initialize();
    console.log(
      stringifyCli({
        backend: "postgres",
        databaseUrl,
        status: "initialized",
      })
    );
  });

resolver
  .command("run-once")
  .description("Index, reconcile, and process one resolver cycle")
  .option("--log-signal", "Log resolution signals for this run")
  .option("--x402", "Queue x402 settlement receipts for this run")
  .action(async (options) => {
    if (options.logSignal) {
      process.env.VERDICT_RESOLVER_LOG_SIGNAL = "true";
    }
    if (options.x402) {
      process.env.VERDICT_RESOLVER_X402 = "true";
    }

    const { orchestrator, statePath, deploymentBlock, databaseUrl, haResolver, pool } = buildResolverRuntime();
    const releaseLock = databaseUrl ? () => {} : acquireProcessLock(`${statePath}.lock`);
    try {
      let summaryOutput: unknown;
      if (databaseUrl) {
        summaryOutput = await haResolver!.runAllCycle();
      } else {
        const summary = await orchestrator.runCycle();
        summaryOutput = {
          ...summary,
          latestBlock: summary.latestBlock.toString(),
        };
      }
      console.log(
        stringifyCli({
          backend: databaseUrl ? "postgres" : "file",
          statePath: databaseUrl ? undefined : statePath,
          databaseUrl: databaseUrl ?? undefined,
          deploymentBlock: deploymentBlock.toString(),
          summary: summaryOutput,
        })
      );
    } finally {
      releaseLock();
      await pool?.end().catch(() => {});
    }
  });

resolver
  .command("daemon")
  .description("Run the resolver loop continuously")
  .option("--poll-ms <number>", "Polling interval in milliseconds", process.env.VERDICT_RESOLVER_POLL_MS ?? "30000")
  .option("--log-signal", "Log resolution signals for this run")
  .option("--x402", "Queue x402 settlement receipts for this run")
  .action(async (options) => {
    if (options.logSignal) {
      process.env.VERDICT_RESOLVER_LOG_SIGNAL = "true";
    }
    if (options.x402) {
      process.env.VERDICT_RESOLVER_X402 = "true";
    }

    const pollMs = Number(options.pollMs);
    const runtime = buildResolverRuntime();
    const { orchestrator, statePath, chain, contractAddress, account, databaseUrl, haResolver, pool } = runtime;
    const releaseLock = databaseUrl ? () => {} : acquireProcessLock(`${statePath}.lock`);
    const shutdown = async () => {
      releaseLock();
      await pool?.end().catch(() => {});
      process.exit(0);
    };
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });

    console.log(
      `resolver daemon started for ${chain.name} contract ${contractAddress} using ${account.address}`
    );
    console.log(databaseUrl ? `database: ${databaseUrl}` : `statePath: ${statePath}`);
    console.log(`pollMs: ${pollMs}`);

    while (true) {
      try {
        let summaryOutput: unknown;
        if (databaseUrl) {
          summaryOutput = await haResolver!.runAllCycle();
        } else {
          const summary = await orchestrator.runCycle();
          summaryOutput = {
            ...summary,
            latestBlock: summary.latestBlock.toString(),
          };
        }
        console.log(
          stringifyCli({
            type: "resolver-cycle",
            at: new Date().toISOString(),
            summary: summaryOutput,
          })
        );
      } catch (error) {
        console.error(error);
      }

      await sleep(pollMs);
    }
  });

resolver
  .command("status")
  .description("Inspect resolver state and unresolved workload")
  .action(async () => {
    const { store, statePath, verdictSdk, databaseUrl, haResolver } = buildResolverRuntime();
    if (databaseUrl && haResolver) {
      console.log(stringifyCli(await haResolver.getStatus()));
      return;
    }
    const state = await store.load();
    const latestBlock = await verdictSdk.getBlockNumber();
    const slas = Object.values(state.slas);
    const jobs = Object.values(state.jobs);
    const unresolvedExpired = slas.filter((sla) => !sla.resolved && latestBlock >= BigInt(sla.targetBlock));

    console.log(
      stringifyCli({
        statePath,
        latestBlock: latestBlock.toString(),
        indexedSlas: slas.length,
        unresolvedExpired: unresolvedExpired.map((sla) => ({
          slaId: sla.slaId,
          targetBlock: sla.targetBlock,
          blocksRemaining: sla.blocksRemaining,
          collateral: sla.collateral,
        })),
        jobsByStatus: jobs.reduce<Record<string, number>>((acc, job) => {
          acc[job.status] = (acc[job.status] ?? 0) + 1;
          return acc;
        }, {}),
        metrics: state.metrics,
        indexer: state.indexer,
        backend: "file",
      })
    );
  });

const resolverRole = resolver.command("role").description("Run an individual HA resolver role against Postgres");

resolverRole
  .command("indexer")
  .description("Run one indexing cycle against the shared Postgres store")
  .action(async () => {
    const { haResolver } = buildResolverRuntime();
    if (!haResolver) {
      throw new Error("VERDICT_RESOLVER_DATABASE_URL must be set for HA role commands");
    }
    console.log(stringifyCli(await haResolver.runIndexerCycle()));
  });

resolverRole
  .command("reconciler")
  .description("Run one reconciliation cycle against the shared Postgres store")
  .action(async () => {
    const { haResolver } = buildResolverRuntime();
    if (!haResolver) {
      throw new Error("VERDICT_RESOLVER_DATABASE_URL must be set for HA role commands");
    }
    console.log(stringifyCli(await haResolver.runReconcilerCycle()));
  });

resolverRole
  .command("worker")
  .description("Run one worker cycle with row-level job claiming against the shared Postgres store")
  .action(async () => {
    const { haResolver } = buildResolverRuntime();
    if (!haResolver) {
      throw new Error("VERDICT_RESOLVER_DATABASE_URL must be set for HA role commands");
    }
    console.log(stringifyCli(await haResolver.runWorkerCycle()));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
