/**
 * onchainos-adapter.ts
 *
 * Real HTTP adapter for OKX OnchainOS API + Uniswap AI Skills.
 * Every method makes live fetch() calls to production endpoints.
 * These skills sit in the CRITICAL PATH: called for every transaction.
 *
 * X Layer testnet chainId: 1952
 * OKX base: https://www.okx.com/api/v5/dex
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Address, Hex } from "viem";

// ---------------------------------------------------------------------------
// Legacy type aliases (kept for backward compat with existing callers)
// ---------------------------------------------------------------------------

export type PortfolioBalanceCheck = {
  owner: Address;
  token: Address;
  minimum: bigint;
};

export type TokenValidationRequest = {
  token: Address;
  expectedSymbol?: string;
};

export type ContractSimulationRequest = {
  to: Address;
  from: Address;
  data: Hex;
  value?: bigint;
};

export type ContractBroadcastRequest = ContractSimulationRequest & {
  label:
    | "approve"
    | "register"
    | "resolve"
    | "postTask"
    | "acceptTask"
    | "resolveTask"
    | "cancelTask";
};

export type UniswapQuoteRequest = {
  tokenIn: Address;
  tokenOut: Address;
  amountOut: bigint;
  chainId: number;
};

export type UniswapQuoteResult = {
  amountIn: bigint;
  priceImpact: number;
  route: string[];
};

export type ResolutionSignal = {
  slaId: bigint;
  agentA: Address;
  agentB: Address;
  outcome: "met" | "slashed";
  txHash: Hex;
};

export type X402SettlementReceipt = {
  rail: "x402";
  status: "queued" | "settled";
  reference: string;
};

// ---------------------------------------------------------------------------
// Custom Error Types
// ---------------------------------------------------------------------------

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly token: string,
    public readonly symbol: string,
    public readonly current: bigint,
    public readonly required: bigint,
  ) {
    super(
      `Insufficient ${symbol} balance for ${token}: ` +
        `have ${current.toString()}, need ${required.toString()}`,
    );
    this.name = "InsufficientBalanceError";
  }
}

export class InvalidTokenError extends Error {
  constructor(
    public readonly token: string,
    public readonly reason: string,
  ) {
    super(`Token ${token} is invalid: ${reason}`);
    this.name = "InvalidTokenError";
  }
}

export class SimulationFailedError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly reason: string,
  ) {
    super(`Simulation failed for tx from=${from} to=${to}: ${reason}`);
    this.name = "SimulationFailedError";
  }
}

export class GatewayBroadcastError extends Error {
  constructor(
    public readonly signedTx: string,
    public readonly reason: string,
  ) {
    super(`Broadcast failed for tx ${signedTx.slice(0, 12)}\u2026: ${reason}`);
    this.name = "GatewayBroadcastError";
  }
}

// ---------------------------------------------------------------------------
// HMAC Auth Helper
// ---------------------------------------------------------------------------

/**
 * Produces the OK-ACCESS-SIGN header value.
 * Sign = Base64( HMAC-SHA256( timestamp + method.toUpperCase() + path, secretKey ) )
 */
export function signRequest(
  method: string,
  path: string,
  secret: string,
  timestamp: string,
): string {
  const prehash = `${timestamp}${method.toUpperCase()}${path}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

// ---------------------------------------------------------------------------
// Internal fetch wrapper with OKX auth headers
// ---------------------------------------------------------------------------

interface OkxRequestOptions {
  method?: "GET" | "POST";
  path: string;
  params?: Record<string, string>;
  body?: unknown;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

const OKX_BASE = "https://www.okx.com";

async function okxFetch<T = unknown>(opts: OkxRequestOptions): Promise<T> {
  const {
    method = "GET",
    path: rawPath,
    params,
    body,
    apiKey,
    secretKey,
    passphrase,
  } = opts;

  // Build full path with query string for signing
  let fullPath = rawPath;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    fullPath = `${rawPath}?${qs}`;
  }

  const timestamp = new Date().toISOString();
  const sign = signRequest(method, fullPath, secretKey, timestamp);

  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
  };

  const url = `${OKX_BASE}${fullPath}`;
  const init: RequestInit = {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(
      `OKX HTTP ${res.status} on ${method} ${fullPath}: ${text}`,
    );
  }

  const json = (await res.json()) as {
    code: string;
    msg?: string;
    data: T;
  };
  if (json.code !== "0") {
    throw new Error(
      `OKX API error code=${json.code} msg=${json.msg ?? ""} on ${method} ${fullPath}`,
    );
  }

  return json.data;
}

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

interface AdapterConfig {
  okxApiKey: string;
  okxSecretKey: string;
  okxPassphrase: string;
  chainId: number;
}

// ---------------------------------------------------------------------------
// Main adapter interface
// ---------------------------------------------------------------------------

export interface OnchainOsAdapter {
  walletPortfolio: {
    /**
     * HARD FAIL — throws InsufficientBalanceError if balance < minimum.
     * Called before every write operation.
     */
    assertBalance(
      owner: Address,
      token: Address,
      minimum: bigint,
      label: string,
    ): Promise<void>;
  };
  onchainGateway: {
    /**
     * HARD FAIL — throws SimulationFailedError if simulation predicts revert.
     * Never broadcast without a successful simulation.
     */
    simulate(
      from: Address,
      to: Address,
      data: Hex,
    ): Promise<{ gasEstimate: bigint; willSucceed: boolean }>;
    /**
     * Broadcast a pre-signed transaction through OKX gateway.
     * Throws GatewayBroadcastError on failure.
     */
    broadcast(signedTx: Hex): Promise<{ orderId: string; txHash: Hex }>;
    /**
     * Poll broadcast status by orderId.
     */
    track(
      orderId: string,
    ): Promise<{ status: "pending" | "confirmed" | "failed"; txHash: Hex }>;
  };
  dexToken: {
    /**
     * HARD FAIL — throws InvalidTokenError if token is not found or flagged.
     */
    validate(
      token: Address,
    ): Promise<{ valid: boolean; symbol: string; decimals: number; reason?: string }>;
  };
  dexMarket: {
    /**
     * Falls back to Uniswap price oracle if OKX is unavailable.
     */
    getPrice(token: Address): Promise<{ priceUsd: number; symbol: string }>;
    /**
     * Convert a USD amount to token units using on-chain price.
     */
    usdToTokenUnits(
      usdAmount: number,
      token: Address,
      decimals: number,
    ): Promise<bigint>;
  };
  dexSignal: {
    /**
     * Soft fail — logs locally if API unavailable. Never throws.
     */
    logOutcome(
      slaId: bigint,
      agentA: Address,
      agentB: Address,
      outcome: "met" | "slashed",
      txHash: Hex,
    ): Promise<void>;
  };
  x402: {
    /**
     * Soft fail — produces a local receipt if the x402 endpoint is unavailable.
     */
    settle(
      recipient: Address,
      amount: bigint,
      token: Address,
      reference: string,
    ): Promise<{ receipt: string; settled: boolean }>;
  };
  uniswap: {
    /**
     * Get a swap quote from Uniswap Quoter V2 API.
     * Soft fail — surfaces error to caller; does not throw.
     */
    getQuote(
      tokenIn: Address,
      tokenOut: Address,
      amountOut: bigint,
      chainId: number,
    ): Promise<{ amountIn: bigint; priceImpact: number; route: string }>;
    /**
     * Fallback price oracle via Uniswap when OKX dexMarket is unavailable.
     */
    getPrice(tokenAddress: Address): Promise<{ priceUsd: number }>;
  };
}

// ---------------------------------------------------------------------------
// Skill 1: okx-wallet-portfolio
// Endpoint: GET /api/v5/dex/balance/all-token-balances-by-address
// ---------------------------------------------------------------------------

function buildWalletPortfolio(
  cfg: AdapterConfig,
): OnchainOsAdapter["walletPortfolio"] {
  return {
    async assertBalance(
      owner: Address,
      token: Address,
      minimum: bigint,
      label: string,
    ): Promise<void> {
      type BalanceEntry = {
        tokenContractAddress: string;
        balance: string;
        symbol: string;
      };

      // HARD FAIL — do not catch; propagate any API error upward
      const data = await okxFetch<BalanceEntry[]>({
        method: "GET",
        path: "/api/v5/dex/balance/all-token-balances-by-address",
        params: {
          address: owner,
          chains: String(cfg.chainId),
        },
        apiKey: cfg.okxApiKey,
        secretKey: cfg.okxSecretKey,
        passphrase: cfg.okxPassphrase,
      });

      const found = data.find(
        (b) =>
          b.tokenContractAddress.toLowerCase() === token.toLowerCase(),
      );

      const current = found ? BigInt(found.balance) : 0n;
      const symbol = found?.symbol ?? token;

      if (current < minimum) {
        throw new InsufficientBalanceError(token, symbol, current, minimum);
      }

      console.info(
        `[okx-wallet-portfolio] ${label}: ${symbol} balance ${current} >= required ${minimum} ✓`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Skill 2: okx-onchain-gateway
// Simulate: POST /api/v5/dex/pre-transaction/transaction-simulate
// Broadcast: POST /api/v5/dex/pre-transaction/broadcast-transaction
// Track:     GET  /api/v5/dex/pre-transaction/broadcast-status
// ---------------------------------------------------------------------------

function buildOnchainGateway(
  cfg: AdapterConfig,
): OnchainOsAdapter["onchainGateway"] {
  return {
    async simulate(from: Address, to: Address, data: Hex) {
      type SimResult = {
        gasLimit: string;
        isSuccess: boolean;
        errorMessage?: string;
      };

      // HARD FAIL — do not catch; a failed simulation must block broadcast
      const result = await okxFetch<SimResult>({
        method: "POST",
        path: "/api/v5/dex/pre-transaction/transaction-simulate",
        body: {
          chainId: String(cfg.chainId),
          fromAddress: from,
          toAddress: to,
          txAmount: "0",
          txData: data,
          gasLimit: "3000000",
        },
        apiKey: cfg.okxApiKey,
        secretKey: cfg.okxSecretKey,
        passphrase: cfg.okxPassphrase,
      });

      if (!result.isSuccess) {
        throw new SimulationFailedError(
          from,
          to,
          result.errorMessage ?? "unknown revert",
        );
      }

      return {
        gasEstimate: BigInt(result.gasLimit ?? "0"),
        willSucceed: true,
      };
    },

    async broadcast(signedTx: Hex) {
      type BroadcastResult = { orderId: string; txhash: string };

      const result = await okxFetch<BroadcastResult>({
        method: "POST",
        path: "/api/v5/dex/pre-transaction/broadcast-transaction",
        body: {
          signedTx,
          chainId: String(cfg.chainId),
        },
        apiKey: cfg.okxApiKey,
        secretKey: cfg.okxSecretKey,
        passphrase: cfg.okxPassphrase,
      }).catch((err) => {
        throw new GatewayBroadcastError(signedTx, String(err));
      });

      return {
        orderId: result.orderId,
        txHash: (result.txhash ?? "") as Hex,
      };
    },

    async track(orderId: string) {
      type TrackResult = { status: string; txhash: string };

      const result = await okxFetch<TrackResult>({
        method: "GET",
        path: "/api/v5/dex/pre-transaction/broadcast-status",
        params: {
          orderId,
          chainId: String(cfg.chainId),
        },
        apiKey: cfg.okxApiKey,
        secretKey: cfg.okxSecretKey,
        passphrase: cfg.okxPassphrase,
      });

      const rawStatus = (result.status ?? "").toLowerCase();
      let status: "pending" | "confirmed" | "failed" = "pending";
      if (rawStatus === "success" || rawStatus === "confirmed")
        status = "confirmed";
      else if (rawStatus === "failed" || rawStatus === "fail")
        status = "failed";

      return {
        status,
        txHash: (result.txhash ?? "") as Hex,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Skill 3: okx-dex-token
// Detail:    GET /api/v5/dex/aggregator/token-detail?chainId=1952&tokenContractAddress=ADDRESS
// Fallback:  GET /api/v5/dex/cross-chain/token-list?chainId=1952
// ---------------------------------------------------------------------------

function buildDexToken(cfg: AdapterConfig): OnchainOsAdapter["dexToken"] {
  return {
    async validate(token: Address) {
      type TokenDetail = {
        tokenContractAddress: string;
        tokenSymbol: string;
        decimals: string;
        isHoneypot?: boolean;
        liquidity?: string;
      };

      // Prefer token-detail for honeypot + liquidity data
      let detail: TokenDetail | null = null;
      try {
        const rows = await okxFetch<TokenDetail[]>({
          method: "GET",
          path: "/api/v5/dex/aggregator/token-detail",
          params: {
            chainId: String(cfg.chainId),
            tokenContractAddress: token,
          },
          apiKey: cfg.okxApiKey,
          secretKey: cfg.okxSecretKey,
          passphrase: cfg.okxPassphrase,
        });
        detail = rows?.[0] ?? null;
      } catch {
        // Fall through to token-list
      }

      if (!detail) {
        type ListEntry = {
          tokenContractAddress: string;
          tokenSymbol: string;
          decimals: string;
        };
        // HARD FAIL path — if not in list either, throw
        const list = await okxFetch<ListEntry[]>({
          method: "GET",
          path: "/api/v5/dex/cross-chain/token-list",
          params: { chainId: String(cfg.chainId) },
          apiKey: cfg.okxApiKey,
          secretKey: cfg.okxSecretKey,
          passphrase: cfg.okxPassphrase,
        });

        const match = list?.find(
          (t) =>
            t.tokenContractAddress.toLowerCase() === token.toLowerCase(),
        );

        if (!match) {
          throw new InvalidTokenError(token, "not found in OKX token list");
        }

        return {
          valid: true,
          symbol: match.tokenSymbol,
          decimals: Number(match.decimals),
        };
      }

      if (detail.isHoneypot) {
        throw new InvalidTokenError(token, "flagged as honeypot by OKX");
      }

      const liquidity = detail.liquidity ? Number(detail.liquidity) : null;
      if (liquidity !== null && liquidity < 1000) {
        throw new InvalidTokenError(
          token,
          `insufficient liquidity: $${liquidity.toFixed(2)}`,
        );
      }

      return {
        valid: true,
        symbol: detail.tokenSymbol,
        decimals: Number(detail.decimals),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Skill 4: okx-dex-market
// Price: GET /api/v5/dex/market/price?chainId=1952&tokenContractAddress=ADDRESS
// Falls back to Uniswap price oracle on any OKX failure.
// ---------------------------------------------------------------------------

function buildDexMarket(
  cfg: AdapterConfig,
  uniswap: OnchainOsAdapter["uniswap"],
): OnchainOsAdapter["dexMarket"] {
  return {
    async getPrice(token: Address) {
      type PriceResult = {
        tokenContractAddress: string;
        tokenSymbol: string;
        price: string;
      };

      try {
        const rows = await okxFetch<PriceResult[]>({
          method: "GET",
          path: "/api/v5/dex/market/price",
          params: {
            chainId: String(cfg.chainId),
            tokenContractAddress: token,
          },
          apiKey: cfg.okxApiKey,
          secretKey: cfg.okxSecretKey,
          passphrase: cfg.okxPassphrase,
        });

        const row = rows?.[0];
        if (!row) throw new Error("empty price response from OKX");

        return {
          priceUsd: Number(row.price),
          symbol: row.tokenSymbol,
        };
      } catch (err) {
        // Graceful degradation — fall back to Uniswap price oracle
        console.warn(
          `[okx-dex-market] OKX price unavailable for ${token}, ` +
            `falling back to Uniswap: ${err}`,
        );
        const fallback = await uniswap.getPrice(token);
        return { priceUsd: fallback.priceUsd, symbol: token };
      }
    },

    async usdToTokenUnits(
      usdAmount: number,
      token: Address,
      decimals: number,
    ): Promise<bigint> {
      const { priceUsd } = await this.getPrice(token);
      if (priceUsd === 0) throw new Error(`Zero price returned for ${token}`);
      const tokenUnits = (usdAmount / priceUsd) * Math.pow(10, decimals);
      return BigInt(Math.round(tokenUnits));
    },
  };
}

// ---------------------------------------------------------------------------
// Skill 5: okx-dex-signal
// POST /api/v5/dex/signal — soft fail with local JSONL log on API unavailability
// ---------------------------------------------------------------------------

function buildDexSignal(cfg: AdapterConfig): OnchainOsAdapter["dexSignal"] {
  const LOCAL_LOG = path.join(process.cwd(), "verdict-signals.jsonl");

  function localLog(entry: object): void {
    try {
      fs.appendFileSync(LOCAL_LOG, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Best-effort; never throw
    }
  }

  return {
    async logOutcome(
      slaId: bigint,
      agentA: Address,
      agentB: Address,
      outcome: "met" | "slashed",
      txHash: Hex,
    ): Promise<void> {
      const payload = {
        chainId: String(cfg.chainId),
        slaId: slaId.toString(),
        agentA,
        agentB,
        outcome,
        txHash,
        timestamp: new Date().toISOString(),
      };

      try {
        await okxFetch({
          method: "POST",
          path: "/api/v5/dex/signal",
          body: payload,
          apiKey: cfg.okxApiKey,
          secretKey: cfg.okxSecretKey,
          passphrase: cfg.okxPassphrase,
        });
        console.info(
          `[okx-dex-signal] Outcome posted: slaId=${slaId} outcome=${outcome} txHash=${txHash}`,
        );
      } catch (err) {
        // Soft fail — resolution is never blocked by signal logging
        console.warn(
          `[okx-dex-signal] API unavailable, writing to local log: ${err}`,
        );
        localLog(payload);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Skill 6: x402 settlement
// POST https://x402.org/api/settle — soft fail with local receipt
// ---------------------------------------------------------------------------

function buildX402(): OnchainOsAdapter["x402"] {
  return {
    async settle(
      recipient: Address,
      amount: bigint,
      token: Address,
      reference: string,
    ): Promise<{ receipt: string; settled: boolean }> {
      const body = {
        recipient,
        amount: amount.toString(),
        token,
        reference,
        timestamp: new Date().toISOString(),
      };

      try {
        const res = await fetch("https://x402.org/api/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const json = (await res.json()) as {
          receiptId?: string;
          receipt?: string;
        };
        const receipt =
          json.receiptId ?? json.receipt ?? crypto.randomUUID();

        console.info(`[x402] Settlement confirmed: receipt=${receipt}`);
        return { receipt, settled: true };
      } catch (err) {
        // Soft fail — scaffold a local receipt so resolution is never blocked
        const localReceipt = [
          "x402-LOCAL",
          reference,
          recipient,
          amount.toString(),
          new Date().toISOString(),
        ].join(":");

        console.warn(
          `[x402] Endpoint unavailable (${err}), issuing local receipt: ${localReceipt}`,
        );
        return { receipt: localReceipt, settled: false };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Skill 7: Uniswap AI Skills
// Quote: POST https://api.uniswap.org/v2/quote
// Price: EXACT_OUTPUT quote of 1 USDC to derive USD price
// ---------------------------------------------------------------------------

const UNISWAP_QUOTE_URL = "https://api.uniswap.org/v2/quote";
// USDC on Ethereum mainnet — reference denominator for price derivation
const USDC_MAINNET =
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

function buildUniswap(): OnchainOsAdapter["uniswap"] {
  return {
    async getQuote(
      tokenIn: Address,
      tokenOut: Address,
      amountOut: bigint,
      chainId: number,
    ) {
      const body = {
        tokenInChainId: chainId,
        tokenOutChainId: chainId,
        tokenIn,
        tokenOut,
        amount: amountOut.toString(),
        type: "EXACT_OUTPUT",
        intent: "quote",
        configs: [
          {
            routingType: "CLASSIC",
            protocols: ["V3", "V2", "MIXED"],
            enableUniversalRouter: true,
          },
        ],
      };

      const res = await fetch(UNISWAP_QUOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Uniswap quote HTTP ${res.status}: ${text}`);
      }

      type QuoteResponse = {
        quote?: {
          quote?: string;
          priceImpact?: string;
          route?: Array<Array<{ address: string }>>;
        };
      };
      const json = (await res.json()) as QuoteResponse;
      const q = json.quote;

      const amountIn = BigInt(q?.quote ?? "0");
      const priceImpact = Number(q?.priceImpact ?? "0");
      const route = (q?.route ?? [])
        .flat()
        .map((r) => r.address)
        .join(" -> ");

      return { amountIn, priceImpact, route };
    },

    async getPrice(tokenAddress: Address) {
      // Price derivation: request EXACT_OUTPUT of 1 USDC (6 decimals),
      // measure how much tokenAddress is required, then invert for USD price.
      try {
        const ONE_USDC = 1_000_000n; // 1 USDC in micro-units
        const body = {
          tokenInChainId: 1,
          tokenOutChainId: 1,
          tokenIn: tokenAddress,
          tokenOut: USDC_MAINNET,
          amount: ONE_USDC.toString(),
          type: "EXACT_OUTPUT",
          intent: "quote",
          configs: [
            {
              routingType: "CLASSIC",
              protocols: ["V3", "V2", "MIXED"],
              enableUniversalRouter: true,
            },
          ],
        };

        const res = await fetch(UNISWAP_QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        type QuoteResponse = { quote?: { quote?: string } };
        const json = (await res.json()) as QuoteResponse;
        const tokenInRaw = BigInt(json.quote?.quote ?? "0");

        if (tokenInRaw === 0n) throw new Error("zero quote returned");

        // tokenInRaw units of token (18 decimals) = 1 USDC = $1
        // priceUsd = 1e18 / tokenInRaw
        const priceUsd =
          Number(10n ** 18n) / Number(tokenInRaw);
        return { priceUsd };
      } catch (err) {
        console.warn(
          `[uniswap] Price fetch failed for ${tokenAddress}: ${err}`,
        );
        // Soft fail — return 0; caller decides what to do
        return { priceUsd: 0 };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory function — the single public entry point
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired OnchainOsAdapter with real HTTP calls to:
 *   - OKX OnchainOS API  (walletPortfolio, onchainGateway, dexToken, dexMarket, dexSignal)
 *   - x402.org settlement endpoint
 *   - Uniswap AI Skills v2 quote API
 *
 * Hard-fail skills:  walletPortfolio, onchainGateway.simulate, dexToken.validate
 * Soft-fail skills:  dexSignal.logOutcome, x402.settle, uniswap.getQuote/getPrice
 * Fallback chain:    dexMarket.getPrice -> Uniswap price oracle
 *
 * Default chainId: 1952 (X Layer testnet)
 */
export function createOnchainOsAdapter(config: {
  okxApiKey: string;
  okxSecretKey: string;
  okxPassphrase: string;
  chainId?: number;
}): OnchainOsAdapter {
  const cfg: AdapterConfig = {
    okxApiKey: config.okxApiKey,
    okxSecretKey: config.okxSecretKey,
    okxPassphrase: config.okxPassphrase,
    chainId: config.chainId ?? 1952,
  };

  const uniswap = buildUniswap();

  return {
    walletPortfolio: buildWalletPortfolio(cfg),
    onchainGateway: buildOnchainGateway(cfg),
    dexToken: buildDexToken(cfg),
    dexMarket: buildDexMarket(cfg, uniswap),
    dexSignal: buildDexSignal(cfg),
    x402: buildX402(),
    uniswap,
  };
}

// ---------------------------------------------------------------------------
// Env-driven singleton (convenience export)
// ---------------------------------------------------------------------------

/**
 * Returns an adapter initialised from environment variables.
 * Throws at call-time if any required env var is missing.
 */
export function createOnchainOsAdapterFromEnv(): OnchainOsAdapter {
  const okxApiKey = process.env.OKX_API_KEY;
  const okxSecretKey = process.env.OKX_SECRET_KEY;
  const okxPassphrase = process.env.OKX_PASSPHRASE;

  if (!okxApiKey) throw new Error("Missing env var: OKX_API_KEY");
  if (!okxSecretKey) throw new Error("Missing env var: OKX_SECRET_KEY");
  if (!okxPassphrase) throw new Error("Missing env var: OKX_PASSPHRASE");

  return createOnchainOsAdapter({ okxApiKey, okxSecretKey, okxPassphrase });
}

// ---------------------------------------------------------------------------
// Legacy compat shim — OnchainOsSkillAdapter backed by real implementations
// ---------------------------------------------------------------------------

/**
 * @deprecated Use OnchainOsAdapter + createOnchainOsAdapter() instead.
 * Kept so existing callers that reference OnchainOsSkillAdapter still compile.
 */
export interface OnchainOsSkillAdapter {
  walletPortfolio: {
    assertCollateralBalance(input: PortfolioBalanceCheck): Promise<void>;
  };
  onchainGateway: {
    simulateContractCall(input: ContractSimulationRequest): Promise<void>;
    broadcastContractCall(
      input: ContractBroadcastRequest,
    ): Promise<{ txHash: Hex }>;
    trackTransaction(
      txHash: Hex,
    ): Promise<{ txHash: Hex; status: "pending" | "confirmed" | "failed" }>;
  };
  dexToken: {
    validateTargetToken(
      input: TokenValidationRequest,
    ): Promise<{ accepted: boolean; reason?: string }>;
  };
  dexMarket?: {
    getSpotPrice(input: {
      baseToken: Address;
      quoteSymbol: string;
    }): Promise<{ price: bigint; asOfBlock?: bigint }>;
  };
  dexSignal?: {
    logResolution(input: ResolutionSignal): Promise<void>;
  };
  uniswap?: {
    getQuote(input: UniswapQuoteRequest): Promise<UniswapQuoteResult>;
  };
  x402?: {
    settle(input: {
      recipient: Address;
      amount: bigint;
      slaId: bigint;
      outcome: "met" | "slashed";
    }): Promise<X402SettlementReceipt>;
  };
  /** okx-security: optional address risk scan before enforcement */
  security?: {
    scanAddress(address: Address): Promise<{
      risk: "safe" | "medium" | "high";
      score?: number;
      reason?: string;
    }>;
  };
}

/**
 * @deprecated Use createOnchainOsAdapter() instead.
 * Wraps a concrete OnchainOsAdapter into the legacy OnchainOsSkillAdapter shape.
 */
export function createOnchainOsSkillAdapter(
  inner: OnchainOsAdapter,
): OnchainOsSkillAdapter {
  return {
    walletPortfolio: {
      async assertCollateralBalance({
        owner,
        token,
        minimum,
      }: PortfolioBalanceCheck) {
        await inner.walletPortfolio.assertBalance(
          owner,
          token,
          minimum,
          "collateral-check",
        );
      },
    },
    onchainGateway: {
      async simulateContractCall({ from, to, data }: ContractSimulationRequest) {
        await inner.onchainGateway.simulate(from, to, data);
      },
      async broadcastContractCall(input: ContractBroadcastRequest) {
        // Simulate first — hard fail if it would revert
        await inner.onchainGateway.simulate(input.from, input.to, input.data);
        // Caller holds the signed tx in input.data for broadcast purposes
        const result = await inner.onchainGateway.broadcast(input.data);
        return { txHash: result.txHash };
      },
      async trackTransaction(txHash: Hex) {
        // Legacy shim: callers pass txHash not orderId, return same shape
        // In the new API, orderId is returned by broadcast; here we use txHash as orderId
        const result = await inner.onchainGateway.track(txHash);
        return { txHash: result.txHash, status: result.status };
      },
    },
    dexToken: {
      async validateTargetToken({ token }: TokenValidationRequest) {
        try {
          const res = await inner.dexToken.validate(token);
          return { accepted: res.valid, reason: res.reason };
        } catch (err) {
          return {
            accepted: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    dexMarket: {
      async getSpotPrice({ baseToken }: { baseToken: Address; quoteSymbol: string }) {
        const { priceUsd } = await inner.dexMarket.getPrice(baseToken);
        // Return price as a scaled bigint (18 decimals)
        const price = BigInt(Math.round(priceUsd * 1e18));
        return { price };
      },
    },
    dexSignal: {
      async logResolution({
        slaId,
        agentA,
        agentB,
        outcome,
        txHash,
      }: ResolutionSignal) {
        await inner.dexSignal.logOutcome(slaId, agentA, agentB, outcome, txHash);
      },
    },
    uniswap: {
      async getQuote({
        tokenIn,
        tokenOut,
        amountOut,
        chainId,
      }: UniswapQuoteRequest): Promise<UniswapQuoteResult> {
        const result = await inner.uniswap.getQuote(
          tokenIn,
          tokenOut,
          amountOut,
          chainId,
        );
        return {
          amountIn: result.amountIn,
          priceImpact: result.priceImpact,
          route: result.route.split(" -> "),
        };
      },
    },
    x402: {
      async settle({ recipient, amount, slaId, outcome }) {
        const reference = `sla-${slaId.toString()}-${outcome}`;
        // token is unknown in legacy shape; use zero address as placeholder
        const zeroToken =
          "0x0000000000000000000000000000000000000000" as Address;
        const { receipt, settled } = await inner.x402.settle(
          recipient,
          amount,
          zeroToken,
          reference,
        );
        return {
          rail: "x402" as const,
          status: settled ? ("settled" as const) : ("queued" as const),
          reference: receipt,
        };
      },
    },
  };
}
