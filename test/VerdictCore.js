const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VerdictCore", function () {
  async function deployFixture() {
    const [agentA, agentB, targetAddress, outsider] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const VerdictCore = await ethers.getContractFactory("VerdictCore");
    const verdict = await VerdictCore.deploy(await usdc.getAddress());
    await verdict.waitForDeployment();

    const startingBalance = 10_000_000n;
    await usdc.mint(agentA.address, startingBalance);

    return { verdict, usdc, agentA, agentB, targetAddress, outsider };
  }

  it("registers an SLA and escrows collateral in the contract", async function () {
    const { verdict, usdc, agentA, agentB, targetAddress } = await deployFixture();
    const collateral = 500_000n;
    const targetAmount = 1_000_000n;
    const targetBlock = BigInt((await ethers.provider.getBlockNumber()) + 10);

    await usdc.connect(agentA).approve(await verdict.getAddress(), collateral);

    await expect(
      verdict.connect(agentA).register({
        agentA: agentA.address,
        agentB: agentB.address,
        targetAddress: targetAddress.address,
        targetAmount,
        targetBlock,
        collateral,
        resolved: false,
      })
    )
      .to.emit(verdict, "SLARegistered")
      .withArgs(1, agentA.address, agentB.address, targetAddress.address, targetAmount, targetBlock, collateral);

    const stored = await verdict.getSLA(1);
    expect(stored.agentA).to.equal(agentA.address);
    expect(stored.agentB).to.equal(agentB.address);
    expect(stored.targetAddress).to.equal(targetAddress.address);
    expect(stored.targetAmount).to.equal(targetAmount);
    expect(stored.collateral).to.equal(collateral);
    expect(stored.resolved).to.equal(false);
    expect(await usdc.balanceOf(await verdict.getAddress())).to.equal(collateral);
  });

  it("returns collateral to agentA when the target balance is met after the deadline", async function () {
    const { verdict, usdc, agentA, agentB, targetAddress } = await deployFixture();
    const collateral = 500_000n;
    const targetAmount = 1_000_000n;

    await usdc.connect(agentA).approve(await verdict.getAddress(), collateral);
    const targetBlock = BigInt((await ethers.provider.getBlockNumber()) + 2);
    await verdict.connect(agentA).register({
      agentA: agentA.address,
      agentB: agentB.address,
      targetAddress: targetAddress.address,
      targetAmount,
      targetBlock,
      collateral,
      resolved: false,
    });

    await usdc.mint(targetAddress.address, targetAmount);
    await ethers.provider.send("hardhat_mine", ["0x3"]);

    await expect(verdict.resolve(1))
      .to.emit(verdict, "SLAResolved")
      .withArgs(1, true, agentA.address, collateral, targetAmount, anyValue);

    expect(await usdc.balanceOf(agentA.address)).to.equal(10_000_000n);
    expect(await usdc.balanceOf(await verdict.getAddress())).to.equal(0);

    const [status, blocksRemaining, currentBalance] = await verdict.status(1);
    expect(status).to.equal("met");
    expect(blocksRemaining).to.equal(0);
    expect(currentBalance).to.equal(targetAmount);
  });

  it("keeps the resolved outcome stable even if the observed balance changes later", async function () {
    const { verdict, usdc, agentA, agentB, targetAddress, outsider } = await deployFixture();
    const collateral = 500_000n;
    const targetAmount = 1_000_000n;

    await usdc.connect(agentA).approve(await verdict.getAddress(), collateral);
    const targetBlock = BigInt((await ethers.provider.getBlockNumber()) + 2);
    await verdict.connect(agentA).register({
      agentA: agentA.address,
      agentB: agentB.address,
      targetAddress: targetAddress.address,
      targetAmount,
      targetBlock,
      collateral,
      resolved: false,
    });

    await usdc.mint(targetAddress.address, targetAmount);
    await ethers.provider.send("hardhat_mine", ["0x3"]);
    await verdict.resolve(1);

    await usdc.connect(targetAddress).transfer(outsider.address, targetAmount);

    const [status, blocksRemaining, currentBalance] = await verdict.status(1);
    expect(status).to.equal("met");
    expect(blocksRemaining).to.equal(0);
    expect(currentBalance).to.equal(0);
  });

  it("slashes collateral to agentB when the target balance is missed", async function () {
    const { verdict, usdc, agentA, agentB, targetAddress } = await deployFixture();
    const collateral = 500_000n;
    const targetAmount = 1_000_000n;

    await usdc.connect(agentA).approve(await verdict.getAddress(), collateral);
    const targetBlock = BigInt((await ethers.provider.getBlockNumber()) + 2);
    await verdict.connect(agentA).register({
      agentA: agentA.address,
      agentB: agentB.address,
      targetAddress: targetAddress.address,
      targetAmount,
      targetBlock,
      collateral,
      resolved: false,
    });

    await ethers.provider.send("hardhat_mine", ["0x3"]);

    await verdict.resolve(1);

    expect(await usdc.balanceOf(agentB.address)).to.equal(collateral);
    expect(await usdc.balanceOf(await verdict.getAddress())).to.equal(0);

    const [status, blocksRemaining, currentBalance] = await verdict.status(1);
    expect(status).to.equal("slashed");
    expect(blocksRemaining).to.equal(0);
    expect(currentBalance).to.equal(0);
  });

  it("rejects non-agentA registration attempts and premature resolution", async function () {
    const { verdict, usdc, agentA, agentB, targetAddress, outsider } = await deployFixture();
    const collateral = 500_000n;
    const targetAmount = 1_000_000n;
    const targetBlock = BigInt((await ethers.provider.getBlockNumber()) + 5);

    await usdc.connect(agentA).approve(await verdict.getAddress(), collateral);

    await expect(
      verdict.connect(outsider).register({
        agentA: agentA.address,
        agentB: agentB.address,
        targetAddress: targetAddress.address,
        targetAmount,
        targetBlock,
        collateral,
        resolved: false,
      })
    ).to.be.revertedWith("VerdictCore: sender must be agentA");

    await verdict.connect(agentA).register({
      agentA: agentA.address,
      agentB: agentB.address,
      targetAddress: targetAddress.address,
      targetAmount,
      targetBlock,
      collateral,
      resolved: false,
    });

    await expect(verdict.resolve(1)).to.be.revertedWith("VerdictCore: deadline not reached");
  });
});
