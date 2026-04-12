const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

function getSettlementTokenAddress() {
  if (network.name === "xlayer_testnet") {
    return process.env.USDC_ADDRESS_TESTNET;
  }

  if (network.name === "xlayer_mainnet") {
    return process.env.USDC_ADDRESS_MAINNET;
  }

  return process.env.USDC_ADDRESS_LOCAL;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const settlementToken = getSettlementTokenAddress();

  if (!settlementToken) {
    throw new Error(`Missing settlement token address for network ${network.name}`);
  }

  const providerNetwork = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("VERDICT deploy");
  console.log(`Network: ${network.name} (${providerNetwork.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} native`);
  console.log(`Settlement token: ${settlementToken}`);

  const settlementTokenCode = await ethers.provider.getCode(settlementToken);
  if (!settlementTokenCode || settlementTokenCode === "0x") {
    throw new Error(`Settlement token ${settlementToken} has no contract code on ${network.name}`);
  }

  const settlementTokenContract = await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    settlementToken
  );

  const [settlementTokenSymbol, settlementTokenDecimals] = await Promise.all([
    settlementTokenContract.symbol(),
    settlementTokenContract.decimals(),
  ]);

  console.log(`Settlement token symbol: ${settlementTokenSymbol}`);
  console.log(`Settlement token decimals: ${settlementTokenDecimals}`);

  const VerdictCore = await ethers.getContractFactory("VerdictCore");
  const verdict = await VerdictCore.deploy(settlementToken);
  await verdict.waitForDeployment();

  const address = await verdict.getAddress();
  const blockNumber = await ethers.provider.getBlockNumber();

  console.log(`VerdictCore deployed to ${address}`);

  const explorerBase =
    network.name === "xlayer_mainnet"
      ? "https://www.oklink.com/xlayer/address/"
      : "https://www.oklink.com/xlayer-test/address/";

  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "VerdictCore.sol", "VerdictCore.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const deploymentRecord = {
    contract: "VerdictCore",
    address,
    settlementToken,
    settlementTokenSymbol,
    settlementTokenDecimals: Number(settlementTokenDecimals),
    chainId: Number(providerNetwork.chainId),
    network: network.name,
    deployer: deployer.address,
    blockNumber,
    deployedAt: new Date().toISOString(),
    explorerUrl: `${explorerBase}${address}`,
    abi: artifact.abi,
  };

  const outputPath = path.join(__dirname, "..", "deployments.json");
  const existing = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, "utf8")) : {};
  existing[network.name] = deploymentRecord;
  fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2));

  const frontendConfigPath = path.join(__dirname, "..", "frontend", "verdict-config.json");
  fs.writeFileSync(
    frontendConfigPath,
    JSON.stringify(
        {
          contractAddress: address,
          settlementToken,
          settlementTokenSymbol,
          tokenDecimals: Number(settlementTokenDecimals),
          chainId: Number(providerNetwork.chainId),
          network: network.name,
        rpcUrl: network.name === "xlayer_mainnet" ? "https://rpc.xlayer.tech" : "https://testrpc.xlayer.tech",
        abi: artifact.abi,
      },
      null,
      2
    )
  );

  console.log(`Deployment record written to ${outputPath}`);
  console.log(`Frontend config written to ${frontendConfigPath}`);
  console.log(`Explorer: ${deploymentRecord.explorerUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
