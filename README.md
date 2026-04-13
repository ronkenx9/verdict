# VERDICT

Deterministic onchain SLA enforcement for machine economies.

VERDICT makes agent commitments enforceable without oracles, judges, or LLMs in the resolution path. A task locks collateral on X Layer, and one deterministic resolution transaction decides whether the executor gets paid or gets slashed.

## Why This Matters

Most agent systems can promise work, but they cannot enforce delivery. VERDICT turns a task into an onchain contract with three properties:

- The bounty is escrowed.
- The executor posts collateral.
- Resolution is decided by deterministic onchain state, not by opinion.

`VerdictScore` extends this with progressive trust, so executors who deliver repeatedly can earn lower collateral requirements over time.

## Fastest Verification Path

If you only want to confirm the repo is real and runnable, do this first:

```bash
npm install
npm run compile
npm test
npm run proof:verify
```

What those commands prove:

- `compile`: contracts and scripts build cleanly
- `test`: contract behavior and resolver logic pass
- `proof:verify`: the recorded `fast1` proof file matches the deployed testnet addresses and expected outcomes

For a local end-to-end demo:

```bash
npm run demo:local
```

For the X Layer testnet flow:

```bash
npm run demo:testnet
```

## What VERDICT Does

At the core, VERDICT enforces a simple machine-deliverable SLA:

1. A poster creates a task and locks the bounty.
2. An executor accepts it and locks collateral.
3. When the deadline passes, the system checks deterministic onchain facts.
4. If the condition is met, collateral returns to the executor and the bounty is paid out.
5. If the condition is not met, the collateral is slashed to the poster.

The current primitive is intentionally narrow. Resolution reads only:

- `block.number`
- `balanceOf(targetAddress)`

That constraint is the point. The narrower the resolver, the harder it is to manipulate.

## Core Contracts

### `VerdictCore`

The deterministic enforcement engine.

- Registers SLA parameters
- Escrows executor collateral
- Resolves success or failure from onchain state
- Returns or slashes collateral in a single transaction

### `TaskMarket`

The task marketplace layer.

- Posts tasks
- Holds bounty funds
- Coordinates accept and resolve flows
- Calls `VerdictCore`
- Records outcomes into `VerdictScore`

### `VerdictScore`

The onchain trust registry.

- Tracks how often an executor has met or failed SLAs
- Tracks the value of successful and failed collateral
- Lets posters price trust based on actual economic history

### `MockUSDC`

Test settlement token used for local and testnet demos.

## Deployed Contracts

Network: X Layer Testnet  
Chain ID: `1952`

| Contract | Address | Explorer |
| --- | --- | --- |
| `VerdictCore` | `0x8d149c622cf56f2663b5368Bc1382c9C711972a8` | [View](https://www.oklink.com/xlayer-test/address/0x8d149c622cf56f2663b5368Bc1382c9C711972a8) |
| `VerdictScore` | `0x70E7Af46711aAB0F8bdb8fe98D9D48F8030CAedf` | [View](https://www.oklink.com/xlayer-test/address/0x70E7Af46711aAB0F8bdb8fe98D9D48F8030CAedf) |
| `TaskMarket` | `0x73d311B3aA256f490c2a6AF77D970fabe7c09acd` | [View](https://www.oklink.com/xlayer-test/address/0x73d311B3aA256f490c2a6AF77D970fabe7c09acd) |
| `mUSDC` | `0xD650E687412e548C2aa7718581d7541876aD72E0` | [View](https://www.oklink.com/xlayer-test/address/0xD650E687412e548C2aa7718581d7541876aD72E0) |

## Live Testnet Proof

The strongest public proof in this repo is the `fast1` run, completed on April 12, 2026.

It demonstrates:

- 4 funded demo agents
- 3 posted tasks
- 2 successful resolutions
- 1 slashed resolution
- onchain `VerdictScore` updates after each outcome

### Real Outcome Sequence

| Task | Outcome | Tx |
| --- | --- | --- |
| `#14` | `MET` | [0x078d4e6658175892aae75b5499e347f58ad0c5945405b45c7da2050f8fa187e3](https://www.oklink.com/xlayer-test/tx/0x078d4e6658175892aae75b5499e347f58ad0c5945405b45c7da2050f8fa187e3) |
| `#15` | `SLASHED` | [0x6302124255da239c35876b1e4d0ded0bb56c7a7b5108da16498c49fa74337a31](https://www.oklink.com/xlayer-test/tx/0x6302124255da239c35876b1e4d0ded0bb56c7a7b5108da16498c49fa74337a31) |
| `#16` | `MET` | [0x0bde5c2ec3feea3b841d602bd526593f0130799eeaabb9327de0db14263bb6ff](https://www.oklink.com/xlayer-test/tx/0x0bde5c2ec3feea3b841d602bd526593f0130799eeaabb9327de0db14263bb6ff) |

### What The Final State Shows

- `GoodBot`: `met=2`, `slashed=0`, `collateralMet=10.00 mUSDC`
- `BadBot`: `met=0`, `slashed=1`, `collateralSlashed=5.00 mUSDC`
- First successful task produced only `5bps (0.05%)` of discount

That small first discount is important because it keeps the proof honest. The trust system is live, but it does not pretend one success magically makes collateral disappear.

### Direct VerdictCore Proof

There is also a smaller direct proof of the base enforcement engine on April 9, 2026:

- Met flow:
  - Register: [0x44521c0034fc85d4498d24873630615ce48d08eb68fbbe9e845a2479c22841dc](https://www.oklink.com/xlayer-test/tx/0x44521c0034fc85d4498d24873630615ce48d08eb68fbbe9e845a2479c22841dc)
  - Resolve `MET`: [0x7d04e0fb8cccb9bf8f28b826e084b0ade757cda210f475e5f90de6ecf7c20f2f](https://www.oklink.com/xlayer-test/tx/0x7d04e0fb8cccb9bf8f28b826e084b0ade757cda210f475e5f90de6ecf7c20f2f)
- Slashed flow:
  - Register: [0x0b586e79856b88166b780ad3cfa602c6dd20f5e19b9a78b771fcc5025357ddca](https://www.oklink.com/xlayer-test/tx/0x0b586e79856b88166b780ad3cfa602c6dd20f5e19b9a78b771fcc5025357ddca)
  - Resolve `SLASHED`: [0xc1ee3e0258385f479f05ba17f0ea287a7b2593aac5ef3630a5af2847246304d6](https://www.oklink.com/xlayer-test/tx/0xc1ee3e0258385f479f05ba17f0ea287a7b2593aac5ef3630a5af2847246304d6)

## Reproduce The Public Proof

If you want to verify the public proof artifact without spending time reading the whole codebase, use this sequence:

```bash
npm install
npm run compile
npm test
npm run proof:verify
```

If you want to rerun the economic loop itself on testnet:

```bash
npm run doctor:full
npm run demo:testnet
```

Expected outcome:

- one `MET` resolution
- one `SLASHED` resolution
- one follow-up `MET` resolution
- a generated proof file matching the deployed addresses and transaction history

## Progressive Trust With `VerdictScore`

`VerdictScore` stores real economic delivery history onchain:

```solidity
struct Record {
    uint256 met;
    uint256 slashed;
    uint256 collateralMet;
    uint256 collateralSlashed;
}
```

The SDK computes a discount from that history:

```typescript
effective = collateralMet - collateralSlashed * 3n
discountBps = min(effective * 100n / 100_000_000n, 5000)
```

Design intent:

- Success increases trust
- Failure is penalized harder than success is rewarded
- Value matters more than task count
- Discount is capped at `5000 bps` (`50%`)

This prevents cheap spam from creating fake reputation.

## Architecture

```text
TaskMarket.sol
  postTask()    -> lock bounty
  acceptTask()  -> lock collateral -> call VerdictCore.register()
  resolveTask() -> call VerdictCore.resolve()
                -> release bounty and collateral according to outcome
                -> try VerdictScore.record() without blocking resolution

VerdictCore.sol
  register() -> store SLA parameters and escrow collateral
  resolve()  -> read block.number + balanceOf(targetAddress)
             -> MET: return collateral to executor
             -> FAIL: slash collateral to poster

VerdictScore.sol
  record()    -> writer-only outcome recording
  getScore()  -> read trust history
  setWriter() -> one-time writer setup, then locked after first record
```

## Hard Constraints

These are not implementation details. They are the product.

- No oracle dependency
- No human judge
- No LLM in the resolution path
- No multisig custody for collateral
- Single-transaction resolution
- Deterministic reads only

## Onchain OS Enforcement Loop

The resolver-side `enforceSLA()` flow is designed to force operational discipline around each resolution:

| Step | Skill | Purpose |
| --- | --- | --- |
| 1 | `okx-wallet-portfolio` | confirm resolver wallet state |
| 2 | `okx-dex-token` | validate settlement token support |
| 3 | `okx-security` | run safety checks before release |
| 4 | `okx-onchain-gateway` simulate | fail early if `resolveTask()` would revert |
| 5 | `okx-onchain-gateway` broadcast | send resolution transaction |
| 6 | `okx-onchain-gateway` track | wait for finality |
| 7 | `x402` | settle resolver bounty rail |
| 8 | `okx-dex-signal` | emit outcome signal |

Behavioral rule:

- Steps `1-6` are hard requirements
- Steps `7-8` are soft-log and signaling steps

## Repository Structure

```text
verdict/
  contracts/
    MockUSDC.sol
    TaskMarket.sol
    VerdictCore.sol
    VerdictScore.sol
  scripts/
    check-env.ts
    demo-local.js
    demo-testnet.js
    deploy.js
    deploy-mock-usdc.js
    deploy-task-market.js
    verify-proof.ts
    verdict-cli.ts
  sdk/
    onchainos-adapter.ts
    task-market-sdk.ts
  frontend/
    index.html
    hero-video.mp4
    verdict-config.json
  test/
    TaskMarket.js
    VerdictCore.js
    VerdictScore.js
  test-ts/
    resolver.test.ts
  sql/
  deployments.json
  demo-testnet-proof-fast1.json
```

## Tech Stack

- Solidity
- Hardhat
- Ethers v6
- TypeScript
- X Layer testnet
- Static frontend proof page

## Prerequisites

- Node.js
- npm
- An RPC path to X Layer testnet through the configured Hardhat network
- A funded deployer key for live testnet deployment or demo execution

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a local `.env` file.

Required values for testnet work:

```env
PRIVATE_KEY=<deployer_private_key>
OKLINK_API_KEY=<oklink_api_key>
```

Useful validation commands:

```bash
npm run doctor
npm run doctor:full
```

### 3. Compile

```bash
npm run compile
```

### 4. Run tests

```bash
npm test
```

### 5. Verify the public proof

```bash
npm run proof:verify
```

## Common Commands

```bash
npm run compile
npm test
npm run typecheck
npm run node
npm run demo:local
npm run demo:testnet
npm run deploy:testnet
npm run deploy:mainnet
npm run deploy:mock-usdc:testnet
npm run proof:verify
npm run cli
```

## What To Read Next

- [`frontend/index.html`](./frontend/index.html): public proof surface
- [`scripts/demo-testnet.js`](./scripts/demo-testnet.js): full fast1 demo flow
- [`scripts/verify-proof.ts`](./scripts/verify-proof.ts): proof verification logic
- [`sdk/task-market-sdk.ts`](./sdk/task-market-sdk.ts): SDK and enforcement integration
- [`contracts/TaskMarket.sol`](./contracts/TaskMarket.sol): marketplace flow
- [`contracts/VerdictCore.sol`](./contracts/VerdictCore.sol): deterministic resolver
- [`contracts/VerdictScore.sol`](./contracts/VerdictScore.sol): trust registry

## Current Project Status

Excluding mainnet deployment, the project is already beyond concept stage:

- real contracts exist
- real testnet addresses exist
- real proof transactions exist
- local and testnet demos exist
- trust scoring is live onchain
- proof verification is automated

The remaining work is mainly operational hardening, distribution, and production rollout.

## One-Line Summary

VERDICT is a machine court: escrowed tasks, deterministic settlement, and onchain trust for agent economies.
