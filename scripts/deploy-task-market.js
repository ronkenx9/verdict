/**
 * deploy-task-market.js
 *
 * Deploys VerdictScore + TaskMarket on top of an already-deployed VerdictCore.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-task-market.js --network xlayer_testnet
 *   npx hardhat run scripts/deploy-task-market.js --network xlayer_mainnet
 *
 * Prerequisites:
 *   - VerdictCore and settlementToken addresses must exist in deployments.json
 *     under the key matching the current Hardhat network name.
 *   - Deployer account must have enough native token for gas.
 *
 * Deploy order (atomic — all in one script):
 *   1. Deploy VerdictScore
 *   2. Deploy TaskMarket(verdictCore, token, verdictScore)
 *   3. Call verdictScore.setWriter(taskMarketAddress)
 */

const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const EXPLORER_BASE = {
  xlayer_testnet: "https://www.oklink.com/xlayer-test/address/",
  xlayer_mainnet: "https://www.oklink.com/xlayer/address/",
};

const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadDeployments() {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error(`deployments.json not found at ${DEPLOYMENTS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
}

function saveDeployments(data) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
}

function explorerUrl(networkName, address) {
  const base = EXPLORER_BASE[networkName] || EXPLORER_BASE["xlayer_testnet"];
  return `${base}${address}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const providerNetwork = await ethers.provider.getNetwork();
  const chainId = Number(providerNetwork.chainId);
  const networkName = network.name;

  // ── 1. Read existing deployment record ──────────────────────────────────

  const deployments = loadDeployments();
  const existing = deployments[networkName];

  if (!existing) {
    throw new Error(
      `No deployment record found for network "${networkName}" in deployments.json. ` +
      `Deploy VerdictCore first with: npx hardhat run scripts/deploy.js --network ${networkName}`
    );
  }

  const verdictCoreAddress = existing.address;
  const settlementToken    = existing.settlementToken;
  const settlementSymbol   = existing.settlementTokenSymbol   || "token";
  const settlementDecimals = existing.settlementTokenDecimals ?? 6;

  if (!verdictCoreAddress || !settlementToken) {
    throw new Error(
      `deployments.json entry for "${networkName}" is missing "address" or "settlementToken".`
    );
  }

  // ── 2. Pre-flight info ───────────────────────────────────────────────────

  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("─────────────────────────────────────────────────");
  console.log("  VerdictScore + TaskMarket deploy");
  console.log("─────────────────────────────────────────────────");
  console.log(`  Network:          ${networkName} (chainId ${chainId})`);
  console.log(`  Deployer:         ${deployer.address}`);
  console.log(`  Balance:          ${ethers.formatEther(balance)} native`);
  console.log(`  VerdictCore:      ${verdictCoreAddress}`);
  console.log(`  Settlement token: ${settlementToken} (${settlementSymbol}, ${settlementDecimals} decimals)`);
  console.log("─────────────────────────────────────────────────");

  const verdictCode = await ethers.provider.getCode(verdictCoreAddress);
  if (!verdictCode || verdictCode === "0x") {
    throw new Error(
      `VerdictCore at ${verdictCoreAddress} has no bytecode on ${networkName}.`
    );
  }

  // ── 3. Deploy VerdictScore ───────────────────────────────────────────────

  console.log("\n[1/3] Deploying VerdictScore...");

  const VerdictScore = await ethers.getContractFactory("VerdictScore");
  const verdictScore = await VerdictScore.deploy();
  await verdictScore.waitForDeployment();

  const verdictScoreAddress = await verdictScore.getAddress();
  console.log(`  VerdictScore deployed: ${verdictScoreAddress}`);
  console.log(`  Explorer: ${explorerUrl(networkName, verdictScoreAddress)}`);

  // ── 4. Deploy TaskMarket ─────────────────────────────────────────────────

  console.log("\n[2/3] Deploying TaskMarket...");

  const TaskMarket = await ethers.getContractFactory("TaskMarket");
  const taskMarket = await TaskMarket.deploy(
    verdictCoreAddress,
    settlementToken,
    verdictScoreAddress
  );
  await taskMarket.waitForDeployment();

  const taskMarketAddress = await taskMarket.getAddress();
  const blockNumber       = await ethers.provider.getBlockNumber();

  console.log(`  TaskMarket deployed:  ${taskMarketAddress}`);
  console.log(`  Explorer: ${explorerUrl(networkName, taskMarketAddress)}`);

  // ── 5. Wire VerdictScore → setWriter(TaskMarket) ─────────────────────────

  console.log("\n[3/3] Wiring VerdictScore.setWriter(TaskMarket)...");

  const setWriterTx = await verdictScore.setWriter(taskMarketAddress);
  await setWriterTx.wait();

  // Verify the writer is correctly set
  const confirmedWriter = await verdictScore.authorizedWriter();
  if (confirmedWriter.toLowerCase() !== taskMarketAddress.toLowerCase()) {
    throw new Error(
      `setWriter verification failed: expected ${taskMarketAddress}, got ${confirmedWriter}`
    );
  }

  console.log(`  authorizedWriter confirmed: ${confirmedWriter}`);
  console.log("  VerdictScore is ready — writer locked on first record() call.");

  // ── 6. Load ABIs ─────────────────────────────────────────────────────────

  function loadAbi(contractName) {
    const p = path.join(
      __dirname, "..", "artifacts", "contracts",
      `${contractName}.sol`, `${contractName}.json`
    );
    if (!fs.existsSync(p)) {
      console.warn(`  WARNING: artifact not found for ${contractName} — ABI not saved`);
      return [];
    }
    return JSON.parse(fs.readFileSync(p, "utf8")).abi;
  }

  const taskMarketAbi    = loadAbi("TaskMarket");
  const verdictScoreAbi  = loadAbi("VerdictScore");

  // ── 7. Update deployments.json ───────────────────────────────────────────

  const taskMarketKey   = `${networkName}_TaskMarket`;
  const verdictScoreKey = `${networkName}_VerdictScore`;

  deployments[taskMarketKey] = {
    contract:                "TaskMarket",
    address:                 taskMarketAddress,
    verdictCore:             verdictCoreAddress,
    verdictScore:            verdictScoreAddress,
    settlementToken,
    settlementTokenSymbol:   settlementSymbol,
    settlementTokenDecimals: settlementDecimals,
    chainId,
    network:                 networkName,
    deployer:                deployer.address,
    blockNumber,
    deployedAt:              new Date().toISOString(),
    explorerUrl:             explorerUrl(networkName, taskMarketAddress),
    abi:                     taskMarketAbi,
  };

  deployments[verdictScoreKey] = {
    contract:    "VerdictScore",
    address:     verdictScoreAddress,
    taskMarket:  taskMarketAddress,
    chainId,
    network:     networkName,
    deployer:    deployer.address,
    blockNumber,
    deployedAt:  new Date().toISOString(),
    explorerUrl: explorerUrl(networkName, verdictScoreAddress),
    abi:         verdictScoreAbi,
  };

  saveDeployments(deployments);

  console.log(`\ndeployments.json updated.`);
  console.log(`  Keys written: "${taskMarketKey}", "${verdictScoreKey}"`);
  console.log(`  VerdictCore entry ("${networkName}") is untouched.`);

  // ── 8. Summary ───────────────────────────────────────────────────────────

  console.log("\n─────────────────────────────────────────────────");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("─────────────────────────────────────────────────");
  console.log(`  VerdictCore:   ${verdictCoreAddress}`);
  console.log(`  VerdictScore:  ${verdictScoreAddress}`);
  console.log(`  TaskMarket:    ${taskMarketAddress}`);
  console.log(`  Token:         ${settlementToken} (${settlementSymbol})`);
  console.log("\n  Next steps:");
  console.log(`  1. Update VERDICT_TASK_MARKET_ADDRESS in .env`);
  console.log(`  2. Update taskMarketAddress in frontend/verdict-config.json`);
  console.log(`  3. Approve TaskMarket to spend ${settlementSymbol} before posting tasks`);
  console.log("─────────────────────────────────────────────────\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
