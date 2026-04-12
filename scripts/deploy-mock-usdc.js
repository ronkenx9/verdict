const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const providerNetwork = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("MockUSDC deploy");
  console.log(`Network: ${network.name} (${providerNetwork.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} native`);

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const token = await MockUSDC.deploy();
  await token.waitForDeployment();

  const address = await token.getAddress();
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);

  console.log(`MockUSDC deployed to ${address}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Decimals: ${decimals}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
