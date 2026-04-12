const { ethers, network } = require("hardhat");

async function mineBlocks(count) {
  const hexBlocks = `0x${count.toString(16)}`;
  await ethers.provider.send("hardhat_mine", [hexBlocks]);
}

async function main() {
  const [agentA, agentB, target] = await ethers.getSigners();

  console.log(`Running VERDICT local demo on ${network.name}`);
  console.log(`agentA: ${agentA.address}`);
  console.log(`agentB: ${agentB.address}`);
  console.log(`target: ${target.address}`);

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  const VerdictCore = await ethers.getContractFactory("VerdictCore");
  const verdict = await VerdictCore.deploy(await usdc.getAddress());
  await verdict.waitForDeployment();

  console.log(`MockUSDC: ${await usdc.getAddress()}`);
  console.log(`VerdictCore: ${await verdict.getAddress()}`);

  await usdc.mint(agentA.address, 20_000_000n);

  console.log("\nScenario 1: SLA met");
  await usdc.connect(agentA).approve(await verdict.getAddress(), 500_000n);
  const currentBlock = await ethers.provider.getBlockNumber();
  await verdict.connect(agentA).register({
    agentA: agentA.address,
    agentB: agentB.address,
    targetAddress: target.address,
    targetAmount: 1_000_000n,
    targetBlock: BigInt(currentBlock + 2),
    collateral: 500_000n,
    resolved: false,
  });

  await usdc.mint(target.address, 1_200_000n);
  await mineBlocks(3);
  await verdict.resolve(1n);
  console.log(`status(1):`, await verdict.status(1n));

  console.log("\nScenario 2: SLA slashed");
  await usdc.connect(agentA).approve(await verdict.getAddress(), 750_000n);
  const currentBlockTwo = await ethers.provider.getBlockNumber();
  await verdict.connect(agentA).register({
    agentA: agentA.address,
    agentB: agentB.address,
    targetAddress: target.address,
    targetAmount: 5_000_000n,
    targetBlock: BigInt(currentBlockTwo + 2),
    collateral: 750_000n,
    resolved: false,
  });

  await mineBlocks(3);
  await verdict.resolve(2n);
  console.log(`status(2):`, await verdict.status(2n));

  console.log("\nBalances");
  console.log(`agentA: ${await usdc.balanceOf(agentA.address)}`);
  console.log(`agentB: ${await usdc.balanceOf(agentB.address)}`);
  console.log(`target: ${await usdc.balanceOf(target.address)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
