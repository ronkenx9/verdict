import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import dotenv from "dotenv";
import { createPublicClient, getAddress, http } from "viem";

dotenv.config({ path: path.join(process.cwd(), ".env") });

if (!process.env.OKX_API_KEY && process.env.ONCHAINOS_API_KEY) {
  process.env.OKX_API_KEY = process.env.ONCHAINOS_API_KEY;
}
if (!process.env.OKX_SECRET_KEY && process.env.ONCHAINOS_SECRET_KEY) {
  process.env.OKX_SECRET_KEY = process.env.ONCHAINOS_SECRET_KEY;
}
if (!process.env.OKX_PASSPHRASE && process.env.ONCHAINOS_PASSPHRASE) {
  process.env.OKX_PASSPHRASE = process.env.ONCHAINOS_PASSPHRASE;
}

const placeholderMarkers = ["REPLACE_WITH", "your_", "your-", "https://REPLACE", "@REPLACE"];

function isFilled(value: string | undefined) {
  if (!value) return false;
  return !placeholderMarkers.some((marker) => value.includes(marker));
}

function report(label: string, ok: boolean, detail: string) {
  const prefix = ok ? "[ok]" : "[missing]";
  console.log(`${prefix} ${label}: ${detail}`);
}

function resolveAlias(keys: readonly string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (isFilled(value)) {
      return { key, value };
    }
  }
  return null;
}

function detectOnchainos() {
  try {
    const output = execFileSync("bash", ["-lc", "source ~/.bashrc >/dev/null 2>&1; onchainos --version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function isSupportedOnchainOsChain(chainId: number) {
  return chainId === 196;
}

async function main() {
  let failures = 0;

  const operatorMode = process.env.VERDICT_OPERATOR_MODE ?? "onchainos";
  const deploySignerMode = process.env.VERDICT_DEPLOY_SIGNER_MODE ?? "private_key";
  const scopeArg = process.argv.find((arg) => arg.startsWith("--scope="));
  const scope = scopeArg?.split("=")[1] ?? "deploy";

  const deployRequired = [
    "VERDICT_NETWORK",
    "VERDICT_RPC_URL",
    "USDC_ADDRESS_TESTNET",
    "USDC_ADDRESS_MAINNET",
    "XLAYER_WALLET_ADDRESS",
  ] as const;

  const submissionRequired = [
    "GITHUB_REPO_URL",
    "CONTACT_EMAIL",
    "CONTACT_TELEGRAM",
  ] as const;

  for (const key of deployRequired) {
    const value = process.env[key];
    const ok = isFilled(value);
    report(key, ok, ok ? "configured" : "fill this in .env");
    if (!ok) failures += 1;
  }

  if (scope === "submission" || scope === "full") {
    for (const key of submissionRequired) {
      const value = process.env[key];
      const ok = isFilled(value);
      report(key, ok, ok ? "configured" : "fill this in .env");
      if (!ok) failures += 1;
    }
  } else {
    for (const key of submissionRequired) {
      const value = process.env[key];
      const ok = isFilled(value);
      report(key, ok, ok ? "configured (optional for deploy)" : "skipped for deploy readiness");
    }
  }

  report("VERDICT_OPERATOR_MODE", true, operatorMode);
  report("VERDICT_DEPLOY_SIGNER_MODE", true, deploySignerMode);
  report("doctor scope", true, scope);

  if (operatorMode === "onchainos") {
    const onchainOsRequired = [
      ["ONCHAINOS_API_KEY", "OKX_API_KEY"],
      ["ONCHAINOS_SECRET_KEY", "OKX_SECRET_KEY"],
      ["ONCHAINOS_PASSPHRASE", "OKX_PASSPHRASE"],
    ] as const;
    for (const aliases of onchainOsRequired) {
      const resolved = resolveAlias(aliases);
      const label = aliases.join(" | ");
      const ok = Boolean(resolved);
      report(label, ok, ok ? `configured via ${resolved?.key}` : "required for Agentic Wallet mode");
      if (!ok) failures += 1;
    }
  }

  if (operatorMode === "private_key" || deploySignerMode === "private_key") {
    const privateKey = process.env.PRIVATE_KEY;
    const ok = isFilled(privateKey);
    report("PRIVATE_KEY", ok, ok ? "configured" : "required for direct signer / Hardhat deploy mode");
    if (!ok) failures += 1;
  }

  const envPath = path.join(process.cwd(), ".env");
  report(".env", fs.existsSync(envPath), envPath);
  if (!fs.existsSync(envPath)) failures += 1;

  const frontendConfigPath = path.join(process.cwd(), "frontend", "verdict-config.json");
  const frontendConfigExists = fs.existsSync(frontendConfigPath);
  report("frontend/verdict-config.json", frontendConfigExists, frontendConfigExists ? "ready" : "will be created by deploy");

  const deploymentsPath = path.join(process.cwd(), "deployments.json");
  const deploymentsExists = fs.existsSync(deploymentsPath);
  report("deployments.json", deploymentsExists, deploymentsExists ? "present" : "will be created by deploy");

  const onchainosVersion = detectOnchainos();
  report("onchainos", Boolean(onchainosVersion), onchainosVersion ?? "CLI not found in bash PATH");
  if (operatorMode === "onchainos" && !onchainosVersion) failures += 1;

  const network = process.env.VERDICT_NETWORK ?? "xlayer_testnet";
  const expectedChainId = network === "xlayer_mainnet" ? 196 : 1952;
  const rpcUrl = process.env.VERDICT_RPC_URL;
  const settlementToken =
    network === "xlayer_mainnet" ? process.env.USDC_ADDRESS_MAINNET : process.env.USDC_ADDRESS_TESTNET;

  if (operatorMode === "onchainos") {
    const onchainOsChainSupported = isSupportedOnchainOsChain(expectedChainId);
    report(
      "onchainos chain support",
      onchainOsChainSupported,
      onchainOsChainSupported
        ? `${network} is supported by onchainos wallet contract-call`
        : `${network} is not supported by onchainos wallet contract-call; use VERDICT_OPERATOR_MODE=private_key for testnet`
    );
    if (!onchainOsChainSupported) failures += 1;
  }

  if (isFilled(rpcUrl) && isFilled(settlementToken)) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl) });
      const code = await client.getBytecode({ address: getAddress(settlementToken!) });
      const ok = Boolean(code && code !== "0x");
      report(
        "settlement token contract",
        ok,
        ok ? `${network} token has bytecode` : `${network} token address has no contract code`
      );
      if (!ok) failures += 1;
    } catch (error) {
      report(
        "settlement token contract",
        false,
        error instanceof Error ? error.message : "unable to validate settlement token"
      );
      failures += 1;
    }
  }

  console.log("");
  if (failures > 0) {
    console.log(`VERDICT doctor (${scope}) found ${failures} required value(s) still using placeholders or invalid runtime configuration.`);
    process.exitCode = 1;
    return;
  }

  console.log(`VERDICT doctor (${scope}) passed. You can proceed with deploy:testnet or the CLI.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
