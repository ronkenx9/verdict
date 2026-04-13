---
name: verdict-sdk
description: Use this skill for anything involving the VERDICT SDK, TaskMarket lifecycle methods, VerdictScore discounts, or the Onchain OS adapter. This is the main operating guide for safely understanding and using the SDK.
risk: medium
source: local
---

# VERDICT SDK

Use this skill when the task involves:

- `sdk/task-market-sdk.ts`
- `sdk/onchainos-adapter.ts`
- posting, accepting, resolving, cancelling, or reading tasks
- `VerdictScore` trust math
- integrating VERDICT into scripts, CLIs, agents, or apps
- reviewing whether an SDK integration is safe and truthful

## Goal

Use the SDK accurately without inventing contract behavior, trust math, or resolver guarantees.

The SDK is not just a contract wrapper. It adds:

- human-unit to raw-unit conversion
- adapter-driven safety checks
- approval handling
- score-aware pricing
- optional USD-target task creation

## Read First

Always read:

1. `sdk/task-market-sdk.ts`
2. `sdk/onchainos-adapter.ts`
3. `deployments.json`
4. `README.md`

If contract behavior matters, also read:

5. `contracts/TaskMarket.sol`
6. `contracts/VerdictCore.sol`
7. `contracts/VerdictScore.sol`

## Mental Model

Keep these layers separate:

- `VerdictCore`: deterministic enforcement primitive
- `TaskMarket`: bounty + task lifecycle marketplace
- SDK: app-facing integration layer over both

Do not describe SDK behavior as if it were raw contract behavior, and do not describe raw contract behavior as if the SDK always guarantees it.

## Main SDK Surface

Main class:

- `TaskMarketSdk`

Constructor patterns:

- `new TaskMarketSdk(config)`
- `createTaskMarketSdk(config)`

Main exported types:

- `TaskStatus`
- `Task`
- `PostTaskParams`
- `TaskWriteResult`
- `TaskMarketSdkConfig`

Main exported helpers:

- `computeDiscountBps(collateralMet, collateralSlashed)`
- `NATIVE_TOKEN`

Main write methods:

- `postTask(params)`
- `acceptTask(taskId)`
- `resolveTask(taskId)`
- `cancelTask(taskId)`

Main read method to anchor on:

- `getTask(taskId)`

## Fast Rules

- Treat `adapter` as dev/test-optional, production-required
- Treat `walletClient` as required for writes
- Treat `verdictScoreAddress` as optional
- Treat token decimals as `6` by default unless explicitly changed
- Treat `valueCondition` as conditional behavior, not guaranteed live pricing
- Treat Uniswap quote logic as advisory, not automatic execution
- Treat resolution outcome as event-derived, not guessed

## Config Rules

Expect these config fields:

- `contractAddress`
- `settlementToken`
- `chain`
- `rpcUrl`

Important optional fields:

- `accountAddress`
- `walletClient`
- `publicClient`
- `adapter`
- `verdictScoreAddress`

Do not assume score features are active just because the repo contains `VerdictScore`.

## Amount Rules

The SDK accepts human-readable strings at the API boundary, especially in `PostTaskParams`.

Examples:

- `bounty: "10"`
- `collateralReq: "5"`
- `targetAmount: "25"`

The SDK converts them into raw units using token decimals.

Default:

- `tokenDecimals ?? 6`

Never assume `18` decimals unless the caller explicitly changed it.

## `valueCondition`

`valueCondition` allows a USD-denominated target:

- it may override `targetAmount`
- it depends on `adapter.dexMarket`
- if market data is missing, the SDK can fall back to the caller-provided raw `targetAmount`

Do not explain it as "always USD-priced onchain." That is not what the SDK guarantees.

## `NATIVE_TOKEN`

`NATIVE_TOKEN` is a sentinel for the native chain token.

It is not:

- a deployed ERC-20
- a settlement-token contract to query directly

## Task Status

SDK status labels are:

- `open`
- `accepted`
- `resolved`

Use those labels when speaking at the SDK layer.

## Discount Math

Canonical helper:

- `computeDiscountBps(collateralMet, collateralSlashed)`

Real logic:

```ts
effective = collateralMet - collateralSlashed * 3n
bps = Number((effective * 100n) / 100_000_000n)
discountBps = Math.min(bps, 5000)
```

Meaning:

- slashes count 3x against trust
- each `100 USDC` of effective history adds `1%`
- cap is `50%`

Do not overstate trust gains after one success.

## Approval Rules

The SDK handles approvals deliberately:

- checks allowance first
- reuses sufficient allowance
- may reset to `0` before re-approving if allowance is non-zero but too small

Do not recommend bypassing approval logic casually.

## Main Write Flows

### `postTask(params)`

Real flow:

1. hash description
2. convert amounts to raw units
3. optionally derive target amount from `valueCondition`
4. check poster balance
5. validate token
6. simulate approval
7. simulate `postTask`
8. ensure approval
9. broadcast
10. track finality
11. read `TaskPosted`

If no adapter is configured, the SDK uses a direct-write dev-mode path. Treat that as dev/test only.

### `acceptTask(taskId)`

Real flow:

1. read task
2. check executor collateral balance
3. validate token
4. optionally get advisory Uniswap quote if delivery balance is short
5. simulate `acceptTask`
6. ensure collateral approval
7. broadcast
8. track finality
9. read `TaskAccepted`

### `resolveTask(taskId)`

Real flow:

1. prepare calldata
2. simulate resolution
3. broadcast
4. track finality
5. read `TaskResolved`
6. derive `met` from the emitted event
7. continue soft auxiliary steps if configured

Important:

- outcome is not guessed
- outcome is not judged by the SDK
- outcome is read from chain result

### `cancelTask(taskId)`

This is a state-changing lifecycle action. Do not imply it is always allowed without checking task state and contract rules.

## Adapter Map

Main adapter areas:

- `walletPortfolio`
- `onchainGateway`
- `dexToken`
- `dexMarket`
- `dexSignal`
- `x402`
- `uniswap`

How to think about them:

- `walletPortfolio`: hard precondition checks
- `onchainGateway`: simulate, broadcast, track
- `dexToken`: validation gate
- `dexMarket`: pricing support for `valueCondition`
- `dexSignal`: soft outcome logging
- `x402`: soft settlement rail support
- `uniswap`: advisory quote support and price fallback

## Wrapper Rule

The SDK may use wrapper names that differ from lower-level adapter primitives.

Examples:

- `assertCollateralBalance(...)` vs `assertBalance(...)`
- `simulateContractCall(...)` vs `simulate(...)`
- `broadcastContractCall(...)` vs `broadcast(...)`
- `trackTransaction(...)` vs `track(...)`
- `validateTargetToken(...)` vs `validate(...)`

Default interpretation:

- wrapper-name difference is not automatically a semantic difference
- only call it a mismatch if the behavior diverges

## Unsafe Assumptions To Avoid

- “`adapter?` in TypeScript means safe to omit in production”
- “`valueCondition` always means live USD conversion”
- “Uniswap quote means automatic token purchase”
- “one successful task creates a big discount”
- “score features are always active”
- “the SDK decides task outcome”

## Canonical Safe Explanations

### Adapter Optionality

Good:

“`adapter` is optional in the config type, but the SDK’s no-adapter path is a dev/test direct-write mode. Production integrations should treat the adapter as required.”

Bad:

“The adapter is optional, so production can skip it.”

### `valueCondition`

Good:

“If you pass `valueCondition`, the SDK may convert a USD target into token-denominated units using `dexMarket`; if that market adapter is missing, it can fall back to the raw `targetAmount` instead.”

Bad:

“`valueCondition` means the task is always live-priced in USD.”

### Resolution Truth

Good:

“`resolveTask()` determines `met` from the emitted `TaskResolved` event after simulation, broadcast, and confirmation.”

Bad:

“The SDK checks if the task was successful and then marks it met.”

## Review Checklist

When reviewing SDK changes, check:

- are decimals handled correctly
- is `valueCondition` explained honestly
- is adapter omission limited to dev/test
- are approvals handled safely
- is simulation required before broadcast
- are event reads used to confirm outcomes
- are score discounts described with the real formula
- are addresses loaded from config instead of random hardcoding

## Answer Pattern

When answering SDK questions:

1. identify the layer
2. name the file
3. name the method or helper
4. state the real behavior
5. state any production caveat

## Verification

Run these before claiming SDK work is complete:

```bash
npm run compile
npm test
npm run typecheck
npm run proof:verify
```

If `proof:verify` is unavailable on the current branch, say that clearly.

## One-Line Summary

Use the VERDICT SDK as a safety-aware integration layer over `TaskMarket`, not as a generic wrapper around contract calls.
