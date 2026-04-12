/**
 * Full VERDICT + VerdictScore live demo on X Layer testnet.
 *
 * Runs 4 agents through the full loop:
 * post -> accept -> deliver -> resolve -> score -> reduced collateral
 *
 * Usage:
 *   npx hardhat run scripts/demo-testnet.js --network xlayer_testnet
 */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEMO_RUN_TAG = process.env.VERDICT_DEMO_TAG || "default";
const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");
const DEMO_PROOF_PATH = path.join(__dirname, "..", `demo-testnet-proof-${DEMO_RUN_TAG}.json`);
const RPC_URL = "https://testrpc.xlayer.tech";
const DEADLINE_BLOCKS = Number(process.env.VERDICT_DEMO_DEADLINE_BLOCKS || "3000");
const BLOCK_POLL_MS = 4000;
const RECEIPT_POLL_MS = 2000;
const RECEIPT_TIMEOUT_MS = 180000;
const FUND_AMOUNT = ethers.parseEther("0.005");

const BOUNTY = 10_000_000n;
const COLLATERAL = 5_000_000n;
const TARGET_AMOUNT = 1_000_000n;

const loadDeployments = () => JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));

const fmt = (raw, decimals = 6) => (Number(raw) / 10 ** decimals).toFixed(2);

const ensureArtifactDir = () => {
  fs.mkdirSync(path.dirname(DEMO_PROOF_PATH), { recursive: true });
};

const writeProof = (proof) => {
  ensureArtifactDir();
  fs.writeFileSync(DEMO_PROOF_PATH, JSON.stringify(proof, null, 2));
};

const deriveDemoWallet = (baseKey, label, provider) => {
  const derivedKey = ethers.keccak256(ethers.toUtf8Bytes(`${baseKey}:${DEMO_RUN_TAG}:${label}`));
  return new ethers.Wallet(derivedKey, provider);
};

async function withRetry(fn, label, retries = 6, delayMs = 8000) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = error?.message || "";
      const code = error?.code || "RPC";
      const retryable =
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        message.includes("Timeout") ||
        message.includes("timeout") ||
        message.includes("502") ||
        message.includes("Bad Gateway") ||
        message.includes("Invalid JSON-RPC response") ||
        message.includes("HH110") ||
        message.includes("ECONNRESET") ||
        message.includes("ECONNREFUSED") ||
        message.includes("fetch failed") ||
        message.includes("receipt timeout");

      if (!retryable || attempt === retries - 1) {
        throw error;
      }

      const waitMs = delayMs * (attempt + 1);
      console.log(
        `  [retry] ${label} failed (${code}). Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${retries - 1}...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function waitForReceipt(provider, txHash, label, timeoutMs = RECEIPT_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      if (Number(receipt.status) !== 1) {
        throw new Error(`${label} failed on-chain: ${txHash}`);
      }
      return receipt;
    }

    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }

  throw new Error(`${label} receipt timeout after ${timeoutMs / 1000}s: ${txHash}`);
}

async function sendAndConfirm(sendTx, provider, label) {
  const tx = await sendTx();
  await waitForReceipt(provider, tx.hash, label);
  return tx;
}

async function waitForBlock(provider, targetBlock) {
  process.stdout.write(`  waiting for block ${targetBlock}...`);

  while (true) {
    try {
      const current = await provider.getBlockNumber();
      if (current > targetBlock) {
        console.log(` done (at block ${current})`);
        return current;
      }

      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
    } catch (error) {
      process.stdout.write("!");
      await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
    }
  }
}

async function printScores(verdictScore, agents) {
  console.log("\n  Scoreboard");
  for (const [name, address] of agents) {
    const [met, slashed, collateralMet, collateralSlashed] = await verdictScore.getScore(address);
    const effective = BigInt(collateralMet) - BigInt(collateralSlashed) * 3n;
    const discountBps = effective <= 0n ? 0 : Math.min(Number((effective * 100n) / 100_000_000n), 5000);
    console.log(
      `    ${name.padEnd(10)} met=${met} slashed=${slashed} collateralMet=${fmt(collateralMet)} collateralSlashed=${fmt(
        collateralSlashed
      )} discount=${(discountBps / 100).toFixed(0)}%`
    );
  }
  console.log("");
}

async function main() {
  const networkName = network.name;
  const rawPrivateKey = process.env.PRIVATE_KEY;
  if (!rawPrivateKey || rawPrivateKey.includes("REPLACE_WITH")) {
    throw new Error("PRIVATE_KEY is required to run the testnet demo");
  }

  const privateKey = rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(privateKey, provider);
  const proof = {
    network: networkName,
    runTag: DEMO_RUN_TAG,
    generatedAt: new Date().toISOString(),
    contracts: {},
    agents: {},
    transactions: [],
  };

  console.log("================================================================");
  console.log("  VERDICT + VerdictScore Live Testnet Demo");
  console.log("================================================================");
  console.log(`  Network:  ${networkName}`);
  console.log(`  Run tag:  ${DEMO_RUN_TAG}`);
  console.log(`  Deadline blocks: ${DEADLINE_BLOCKS}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(await provider.getBalance(deployer.address))} OKB\n`);

  const deployments = loadDeployments();
  const vcEntry = deployments[networkName];
  const tmEntry = deployments[`${networkName}_TaskMarket`];
  const vsEntry = deployments[`${networkName}_VerdictScore`];

  if (!vcEntry || !tmEntry || !vsEntry) {
    throw new Error(`Missing deployment entries for ${networkName}. Re-run deploy-task-market.js first.`);
  }

  const mUSDC = new ethers.Contract(
    vcEntry.settlementToken,
    [
      "function mint(address to, uint256 amount) external",
      "function balanceOf(address account) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function transfer(address to, uint256 amount) returns (bool)",
    ],
    deployer
  );

  const taskMarket = new ethers.Contract(tmEntry.address, tmEntry.abi, deployer);
  const verdictScore = new ethers.Contract(
    vsEntry.address,
    [
      "function getScore(address executor) view returns (uint256 met, uint256 slashed, uint256 collateralMet, uint256 collateralSlashed)",
      "function authorizedWriter() view returns (address)",
    ],
    provider
  );

  console.log(`  VerdictCore:  ${vcEntry.address}`);
  console.log(`  VerdictScore: ${vsEntry.address}`);
  console.log(`  TaskMarket:   ${tmEntry.address}`);
  console.log(`  mUSDC:        ${vcEntry.settlementToken}\n`);
  proof.contracts = {
    verdictCore: vcEntry.address,
    verdictScore: vsEntry.address,
    taskMarket: tmEntry.address,
    settlementToken: vcEntry.settlementToken,
  };

  const writer = await verdictScore.authorizedWriter();
  if (writer.toLowerCase() !== tmEntry.address.toLowerCase()) {
    throw new Error(`VerdictScore writer mismatch: ${writer} != ${tmEntry.address}`);
  }
  console.log("  OK VerdictScore.authorizedWriter confirmed\n");

  const poster = deriveDemoWallet(privateKey, "poster", provider);
  const goodBot = deriveDemoWallet(privateKey, "goodbot", provider);
  const badBot = deriveDemoWallet(privateKey, "badbot", provider);
  const resolver = deriveDemoWallet(privateKey, "resolver", provider);

  const agentList = [
    ["Poster", poster.address],
    ["GoodBot", goodBot.address],
    ["BadBot", badBot.address],
    ["Resolver", resolver.address],
  ];

  console.log("  Agent wallets:");
  for (const [name, address] of agentList) {
    console.log(`    ${name.padEnd(10)} ${address}`);
    proof.agents[name.toLowerCase()] = address;
  }
  writeProof(proof);

  console.log(`\n[FUND] Sending ${ethers.formatEther(FUND_AMOUNT)} OKB to each agent...`);
  for (const [name, address] of agentList) {
    const tx = await withRetry(
      () => sendAndConfirm(() => deployer.sendTransaction({ to: address, value: FUND_AMOUNT }), provider, `Fund ${name}`),
      `Fund ${name}`
    );
    console.log(`  OK ${name} funded (${tx.hash})`);
    proof.transactions.push({ step: `fund_${name.toLowerCase()}`, txHash: tx.hash });
    writeProof(proof);
  }

  console.log("\n[MINT] Minting mUSDC...");
  await withRetry(
    () => sendAndConfirm(() => mUSDC.mint(poster.address, BOUNTY * 3n), provider, "Mint Poster"),
    "Mint Poster"
  );
  await withRetry(
    () =>
      sendAndConfirm(
        () => mUSDC.mint(goodBot.address, COLLATERAL * 2n + TARGET_AMOUNT * 3n),
        provider,
        "Mint GoodBot"
      ),
    "Mint GoodBot"
  );
  await withRetry(
    () => sendAndConfirm(() => mUSDC.mint(badBot.address, COLLATERAL), provider, "Mint BadBot"),
    "Mint BadBot"
  );
  console.log(`  OK Poster  <- ${fmt(BOUNTY * 3n)} mUSDC`);
  console.log(`  OK GoodBot <- ${fmt(COLLATERAL * 2n + TARGET_AMOUNT * 3n)} mUSDC`);
  console.log(`  OK BadBot  <- ${fmt(COLLATERAL)} mUSDC`);

  console.log("\n================================================================");
  console.log("  ROUND 1 - Poster posts 3 tasks");
  console.log("================================================================");

  const posterMarket = taskMarket.connect(poster);
  const posterUSDC = mUSDC.connect(poster);
  const goodBotMarket = taskMarket.connect(goodBot);
  const goodBotUSDC = mUSDC.connect(goodBot);
  const badBotMarket = taskMarket.connect(badBot);
  const badBotUSDC = mUSDC.connect(badBot);
  const resolverMarket = taskMarket.connect(resolver);

  await withRetry(
    () => sendAndConfirm(() => posterUSDC.approve(tmEntry.address, BOUNTY * 3n), provider, "Poster approve"),
    "Poster approve"
  );
  console.log("  OK Poster approved TaskMarket for 30 mUSDC");

  const initialTaskCount = BigInt(await taskMarket.taskCount());

  let deadline = BigInt((await provider.getBlockNumber()) + DEADLINE_BLOCKS);
  let tx = await withRetry(
    () =>
      sendAndConfirm(
        () =>
          posterMarket.postTask(
            ethers.keccak256(ethers.toUtf8Bytes(`Deploy analytics dashboard by block ${deadline}`)),
            BOUNTY,
            COLLATERAL,
            TARGET_AMOUNT,
            goodBot.address,
            deadline
          ),
        provider,
        "Post Task #1"
    ),
    "Post Task #1"
  );
  const task1Id = initialTaskCount + 1n;
  const task1Deadline = deadline;
  console.log(`  OK Task #1 posted (${tx.hash}) deadline=${deadline}`);
  proof.transactions.push({ step: "post_task_1", txHash: tx.hash, taskId: task1Id.toString(), deadline: task1Deadline.toString() });
  writeProof(proof);

  deadline = BigInt((await provider.getBlockNumber()) + DEADLINE_BLOCKS);
  tx = await withRetry(
    () =>
      sendAndConfirm(
        () =>
          posterMarket.postTask(
            ethers.keccak256(ethers.toUtf8Bytes(`Audit smart contract by block ${deadline}`)),
            BOUNTY,
            COLLATERAL,
            TARGET_AMOUNT,
            badBot.address,
            deadline
          ),
        provider,
        "Post Task #2"
    ),
    "Post Task #2"
  );
  const task2Id = initialTaskCount + 2n;
  const task2Deadline = deadline;
  console.log(`  OK Task #2 posted (${tx.hash}) deadline=${deadline}`);
  proof.transactions.push({ step: "post_task_2", txHash: tx.hash, taskId: task2Id.toString(), deadline: task2Deadline.toString() });
  writeProof(proof);

  console.log("\n================================================================");
  console.log("  ROUND 2 - Accept and deliver");
  console.log("================================================================");

  await withRetry(async () => {
    await sendAndConfirm(() => goodBotUSDC.approve(tmEntry.address, COLLATERAL), provider, "GoodBot approve");
    tx = await sendAndConfirm(() => goodBotMarket.acceptTask(task1Id), provider, "GoodBot acceptTask");
  }, "GoodBot acceptTask");
  console.log(`  OK GoodBot accepted Task #1 (${tx.hash})`);
  proof.transactions.push({ step: "accept_task_1", txHash: tx.hash, taskId: task1Id.toString() });
  writeProof(proof);

  await withRetry(async () => {
    await sendAndConfirm(() => badBotUSDC.approve(tmEntry.address, COLLATERAL), provider, "BadBot approve");
    tx = await sendAndConfirm(() => badBotMarket.acceptTask(task2Id), provider, "BadBot acceptTask");
  }, "BadBot acceptTask");
  console.log(`  OK BadBot accepted Task #2 (${tx.hash})`);
  proof.transactions.push({ step: "accept_task_2", txHash: tx.hash, taskId: task2Id.toString() });
  writeProof(proof);

  await withRetry(
    () => sendAndConfirm(() => goodBotUSDC.transfer(goodBot.address, TARGET_AMOUNT), provider, "GoodBot delivery"),
    "GoodBot delivery"
  );
  console.log(`  OK GoodBot target balance now ${fmt(await mUSDC.balanceOf(goodBot.address))} mUSDC`);
  proof.transactions.push({ step: "deliver_task_1", targetAddress: goodBot.address });
  writeProof(proof);
  console.log("  BadBot stays silent and will be slashed.");

  const maxDeadline = task1Deadline > task2Deadline ? task1Deadline : task2Deadline;
  console.log(`\n[WAIT] Waiting for block ${maxDeadline} to pass...`);
  await waitForBlock(provider, Number(maxDeadline));

  console.log("\n================================================================");
  console.log("  ROUND 3 - Resolve both tasks");
  console.log("================================================================");

  tx = await withRetry(
    () => sendAndConfirm(() => resolverMarket.resolveTask(task1Id), provider, "Resolve Task #1"),
    "Resolve Task #1"
  );
  console.log(`  OK Task #1 resolved (${tx.hash})`);
  proof.transactions.push({ step: "resolve_task_1", txHash: tx.hash, taskId: task1Id.toString() });
  writeProof(proof);

  tx = await withRetry(
    () => sendAndConfirm(() => resolverMarket.resolveTask(task2Id), provider, "Resolve Task #2"),
    "Resolve Task #2"
  );
  console.log(`  OK Task #2 resolved (${tx.hash})`);
  proof.transactions.push({ step: "resolve_task_2", txHash: tx.hash, taskId: task2Id.toString() });
  writeProof(proof);

  console.log("\n  Balances after Round 3:");
  console.log(`    Poster   ${fmt(await mUSDC.balanceOf(poster.address))} mUSDC`);
  console.log(`    GoodBot  ${fmt(await mUSDC.balanceOf(goodBot.address))} mUSDC`);
  console.log(`    BadBot   ${fmt(await mUSDC.balanceOf(badBot.address))} mUSDC`);
  await printScores(verdictScore, agentList);

  console.log("================================================================");
  console.log("  ROUND 4 - Progressive trust with lower collateral");
  console.log("================================================================");

  const [met, , collateralMet, collateralSlashed] = await verdictScore.getScore(goodBot.address);
  const effective = BigInt(collateralMet) - BigInt(collateralSlashed) * 3n;
  const discountBps = effective <= 0n ? 0 : Math.min(Number((effective * 100n) / 100_000_000n), 5000);
  const adjustedCollateral = (COLLATERAL * BigInt(10_000 - discountBps)) / 10_000n;

  console.log(`  GoodBot score: ${met} met, collateralMet=${fmt(collateralMet)} mUSDC`);
  console.log(`  Discount: ${discountBps}bps (${discountBps / 100}%)`);
  console.log(`  Adjusted collateral: ${fmt(adjustedCollateral)} mUSDC`);

  const deadline3 = BigInt((await provider.getBlockNumber()) + DEADLINE_BLOCKS);
  tx = await withRetry(
    () =>
      sendAndConfirm(
        () =>
          posterMarket.postTask(
            ethers.keccak256(ethers.toUtf8Bytes(`Write technical spec by block ${deadline3}`)),
            BOUNTY,
            adjustedCollateral,
            TARGET_AMOUNT,
            goodBot.address,
            deadline3
          ),
        provider,
        "Post Task #3"
    ),
    "Post Task #3"
  );
  const task3Id = initialTaskCount + 3n;
  console.log(`  OK Task #3 posted (${tx.hash})`);
  proof.transactions.push({ step: "post_task_3", txHash: tx.hash, taskId: task3Id.toString(), deadline: deadline3.toString() });
  writeProof(proof);

  await withRetry(async () => {
    await sendAndConfirm(
      () => goodBotUSDC.approve(tmEntry.address, adjustedCollateral),
      provider,
      "GoodBot approve Task #3"
    );
    tx = await sendAndConfirm(() => goodBotMarket.acceptTask(task3Id), provider, "GoodBot accept Task #3");
  }, "GoodBot accept Task #3");
  console.log(`  OK GoodBot accepted Task #3 (${tx.hash})`);
  proof.transactions.push({ step: "accept_task_3", txHash: tx.hash, taskId: task3Id.toString() });
  writeProof(proof);

  await withRetry(
    () => sendAndConfirm(() => goodBotUSDC.transfer(goodBot.address, TARGET_AMOUNT), provider, "GoodBot deliver Task #3"),
    "GoodBot deliver Task #3"
  );
  console.log("  OK GoodBot delivered Task #3");
  proof.transactions.push({ step: "deliver_task_3", targetAddress: goodBot.address });
  writeProof(proof);

  console.log(`\n[WAIT] Waiting for block ${deadline3} to pass...`);
  await waitForBlock(provider, Number(deadline3));

  tx = await withRetry(
    () => sendAndConfirm(() => resolverMarket.resolveTask(task3Id), provider, "Resolve Task #3"),
    "Resolve Task #3"
  );
  console.log(`  OK Task #3 resolved (${tx.hash})`);
  proof.transactions.push({ step: "resolve_task_3", txHash: tx.hash, taskId: task3Id.toString() });
  proof.finalBalances = {
    poster: (await mUSDC.balanceOf(poster.address)).toString(),
    goodBot: (await mUSDC.balanceOf(goodBot.address)).toString(),
    badBot: (await mUSDC.balanceOf(badBot.address)).toString(),
    resolver: (await mUSDC.balanceOf(resolver.address)).toString(),
  };
  writeProof(proof);

  console.log("\n================================================================");
  console.log("  FINAL STATE");
  console.log("================================================================");
  console.log(`  Poster   ${fmt(await mUSDC.balanceOf(poster.address))} mUSDC`);
  console.log(`  GoodBot  ${fmt(await mUSDC.balanceOf(goodBot.address))} mUSDC`);
  console.log(`  BadBot   ${fmt(await mUSDC.balanceOf(badBot.address))} mUSDC`);
  console.log(`  Resolver ${fmt(await mUSDC.balanceOf(resolver.address))} mUSDC`);
  await printScores(verdictScore, agentList);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
