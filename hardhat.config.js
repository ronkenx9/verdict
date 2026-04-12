require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

function resolvePrivateKey() {
  const raw = process.env.PRIVATE_KEY;
  if (!raw || raw.includes("REPLACE_WITH")) {
    return "0x" + "0".repeat(64);
  }

  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  return normalized.length === 66 ? normalized : "0x" + "0".repeat(64);
}

const PRIVATE_KEY = resolvePrivateKey();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    xlayer_testnet: {
      url: "https://testrpc.xlayer.tech",
      chainId: 1952,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
      timeout: 120000,
    },
    xlayer_mainnet: {
      url: "https://rpc.xlayer.tech",
      chainId: 196,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
      timeout: 120000,
    },
    hardhat: {
      chainId: 31337,
    },
  },
  etherscan: {
    apiKey: {
      xlayer_testnet: process.env.OKLINK_API_KEY || "",
      xlayer_mainnet: process.env.OKLINK_API_KEY || "",
    },
    customChains: [
      {
        network: "xlayer_testnet",
        chainId: 1952,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET",
          browserURL: "https://www.oklink.com/xlayer-test",
        },
      },
      {
        network: "xlayer_mainnet",
        chainId: 196,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER",
          browserURL: "https://www.oklink.com/xlayer",
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
