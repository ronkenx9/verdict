const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const RPC_URL = "https://testrpc.xlayer.tech";
const BLOCK_POLL_MS = 4000;
const RECEIPT_POLL_MS = 2000;
const RECEIPT_TIMEOUT_MS = 180000;
const DEMO_PROOF_PATH = path.join(__dirname, "..", "demo-testnet-proof.json");
const DEPLOYMENTS_PATH = path.join(__dirname, "..", "deployments.json");

const BOUNTY = 10_000_000n;
const COLLATERAL = 5_000_000n;
const TARGET_AMOUNT = 1_000_000n;

const fmt = (raw, decimals = 6) => (Number(raw) / 10 ** decimals).toFixed(2);

const loadJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const saveJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

const deriveDemoWallet = (baseKey, label, provider) => {
  const derivedKey = ethers.keccak256(ethers.toUtf8Bytes(`${baseKey}:${label}`));
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
        code === "ECONNRESET" ||
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
      console.log(`  [retry] ${label} failed (${code}), waiting ${waitMs / 1000}s...`);
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
    } catch {
      process.stdout.write("!");
      await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
    }
  }
}

function upsertProofTx(proof, step, patch) {
  const index = proof.transactions.findIndex((entry) => entry.step === step);
  if (index >= 0) {
    proof.transactions[index] = { ...proof.transactions[index], ...patch };
  } else {
    proof.transactions.push({ step, ...patch });
  }
  saveJson(DEMO_PROOF_PATH, proof);
}

async function main() {
  if (!fs.existsSync(DEMO_PROOF_PATH)) {
    throw new Error("Missing artifacts/demo-testnet-proof.json. Run the demo first.");
  }

  const proof = loadJson(DEMO_PROOF_PATH);
  const deployments = loadJson(DEPLOYMENTS_PATH);
  const rawPrivateKey = process.env.PRIVATE_KEY;
  if (!rawPrivateKey || rawPrivateKey.includes("REPLACE_WITH")) {
    throw new Error("PRIVATE_KEY is required to resume the testnet demo");
  }

  const privateKey = rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(privateKey, provider);
  const networkName = network.name;

  const poster = deriveDemoWallet(privateKey, "poster", provider);
  const goodBot = deriveDemoWallet(privateKey, "goodbot", provider);
  const resolver = deriveDemoWallet(privateKey, "resolver", provider);

  const tmEntry = deployments[`${networkName}_TaskMarket`];
  const vsEntry = deployments[`${networkName}_VerdictScore`];
  const vcEntry = deployments[networkName];

  const taskMarket = new ethers.Contract(tmEntry.address, tmEntry.abi, provider);
  const taskMarketAsPoster = taskMarket.connect(poster);
  const taskMarketAsGoodBot = taskMarket.connect(goodBot);
  const taskMarketAsResolver = taskMarket.connect(resolver);

  const verdictScore = new ethers.Contract(
    vsEntry.address,
    [
      "function getScore(address executor) view returns (uint256 met, uint256 slashed, uint256 collateralMet, uint256 collateralSlashed)",
    ],
    provider
  );

  const mUSDC = new ethers.Contract(
    vcEntry.settlementToken,
    [
      "function balanceOf(address account) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function transfer(address to, uint256 amount) returns (bool)",
    ],
    provider
  );

  const mUSDCAsGoodBot = mUSDC.connect(goodBot);

  console.log("Resuming VERDICT demo from proof artifact");
  console.log(`  Poster:   ${poster.address}`);
  console.log(`  GoodBot:  ${goodBot.address}`);
  console.log(`  Resolver: ${resolver.address}`);
  console.log(`  Current block: ${await provider.getBlockNumber()}\n`);

  const task1 = proof.transactions.find((entry) => entry.step === "post_task_1");
  const task2 = proof.transactions.find((entry) => entry.step === "post_task_2");
  const task1Id = BigInt(task1.taskId);
  const task2Id = BigInt(task2.taskId);
  const maxDeadline = Math.max(Number(task1.deadline), Number(task2.deadline));

  const currentBlock = await provider.getBlockNumber();
  if (currentBlock <= maxDeadline) {
    console.log(`[WAIT] Waiting for task 1/2 deadlines to pass...`);
    await waitForBlock(provider, maxDeadline);
  }

  const liveTask1 = await taskMarket.getTask(task1Id);
  if (Number(liveTask1.status) !== 2) {
    const tx = await withRetry(
      () => sendAndConfirm(() => taskMarketAsResolver.resolveTask(task1Id), provider, "Resolve Task #1"),
      "Resolve Task #1"
    );
    console.log(`  OK Task #1 resolved (${tx.hash})`);
    upsertProofTx(proof, "resolve_task_1", { txHash: tx.hash, taskId: task1.taskId });
  }

  const liveTask2 = await taskMarket.getTask(task2Id);
  if (Number(liveTask2.status) !== 2) {
    const tx = await withRetry(
      () => sendAndConfirm(() => taskMarketAsResolver.resolveTask(task2Id), provider, "Resolve Task #2"),
      "Resolve Task #2"
    );
    console.log(`  OK Task #2 resolved (${tx.hash})`);
    upsertProofTx(proof, "resolve_task_2", { txHash: tx.hash, taskId: task2.taskId });
  }

  const [met, , collateralMet, collateralSlashed] = await verdictScore.getScore(goodBot.address);
  const effective = BigInt(collateralMet) - BigInt(collateralSlashed) * 3n;
  const discountBps = effective <= 0n ? 0 : Math.min(Number((effective * 100n) / 100_000_000n), 5000);
  const adjustedCollateral = (COLLATERAL * BigInt(10_000 - discountBps)) / 10_000n;

  console.log(`\nScore after round 3: met=${met}, collateralMet=${fmt(collateralMet)}, discount=${discountBps / 100}%`);

  let task3 = proof.transactions.find((entry) => entry.step === "post_task_3");
  if (!task3) {
    const deadline3 = BigInt((await provider.getBlockNumber()) + 3000);
    const postTx = await withRetry(
      () =>
        sendAndConfirm(
          () =>
            taskMarketAsPoster.postTask(
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

    const taskCount = await taskMarket.taskCount();
    task3 = {
      step: "post_task_3",
      txHash: postTx.hash,
      taskId: taskCount.toString(),
      deadline: deadline3.toString(),
    };
    proof.transactions.push(task3);
    saveJson(DEMO_PROOF_PATH, proof);
    console.log(`  OK Task #3 posted (${postTx.hash})`);
  }

  const task3Id = BigInt(task3.taskId);
  const liveTask3 = await taskMarket.getTask(task3Id);
  if (Number(liveTask3.status) === 0) {
    await withRetry(
      () => sendAndConfirm(() => mUSDCAsGoodBot.approve(tmEntry.address, adjustedCollateral), provider, "GoodBot approve Task #3"),
      "GoodBot approve Task #3"
    );
    const acceptTx = await withRetry(
      () => sendAndConfirm(() => taskMarketAsGoodBot.acceptTask(task3Id), provider, "GoodBot accept Task #3"),
      "GoodBot accept Task #3"
    );
    console.log(`  OK Task #3 accepted (${acceptTx.hash})`);
    upsertProofTx(proof, "accept_task_3", { txHash: acceptTx.hash, taskId: task3.taskId });

    await withRetry(
      () => sendAndConfirm(() => mUSDCAsGoodBot.transfer(goodBot.address, TARGET_AMOUNT), provider, "GoodBot deliver Task #3"),
      "GoodBot deliver Task #3"
    );
    upsertProofTx(proof, "deliver_task_3", { targetAddress: goodBot.address });
    console.log(`  OK Task #3 delivered`);
  }

  const deadline3 = Number(task3.deadline);
  if ((await provider.getBlockNumber()) <= deadline3) {
    console.log(`\n[WAIT] Waiting for task 3 deadline to pass...`);
    await waitForBlock(provider, deadline3);
  }

  const latestTask3 = await taskMarket.getTask(task3Id);
  if (Number(latestTask3.status) !== 2) {
    const resolveTx = await withRetry(
      () => sendAndConfirm(() => taskMarketAsResolver.resolveTask(task3Id), provider, "Resolve Task #3"),
      "Resolve Task #3"
    );
    console.log(`  OK Task #3 resolved (${resolveTx.hash})`);
    upsertProofTx(proof, "resolve_task_3", { txHash: resolveTx.hash, taskId: task3.taskId });
  }

  proof.finalBalances = {
    poster: (await mUSDC.balanceOf(poster.address)).toString(),
    goodBot: (await mUSDC.balanceOf(goodBot.address)).toString(),
    badBot: (await mUSDC.balanceOf(proof.agents.badbot)).toString(),
    resolver: (await mUSDC.balanceOf(resolver.address)).toString(),
  };
  saveJson(DEMO_PROOF_PATH, proof);

  console.log("\nFinal balances:");
  console.log(`  Poster   ${fmt(proof.finalBalances.poster)} mUSDC`);
  console.log(`  GoodBot  ${fmt(proof.finalBalances.goodBot)} mUSDC`);
  console.log(`  BadBot   ${fmt(proof.finalBalances.badBot)} mUSDC`);
  console.log(`  Resolver ${fmt(proof.finalBalances.resolver)} mUSDC`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
