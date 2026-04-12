import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("VerdictCore PayFi Arbitration", function () {
    let verdictCore: any;
    let deployer: SignerWithAddress;
    let serviceProvider: SignerWithAddress;
    let client: SignerWithAddress;

    // 5 AI Jurors
    let jury1: SignerWithAddress;
    let jury2: SignerWithAddress;
    let jury3: SignerWithAddress;
    let jury4: SignerWithAddress;
    let jury5: SignerWithAddress;

    // A malicious actor attempting to forge a signature
    let nonJuror: SignerWithAddress;

    beforeEach(async function () {
        [deployer, serviceProvider, client, jury1, jury2, jury3, jury4, jury5, nonJuror] = await ethers.getSigners();

        const aiJuryWallets = [
            jury1.address,
            jury2.address,
            jury3.address,
            jury4.address,
            jury5.address
        ];

        const VerdictCoreFactory = await ethers.getContractFactory("VerdictCore");
        verdictCore = await VerdictCoreFactory.deploy(aiJuryWallets);
    });

    describe("SLA Registration & Dispute Protocol", function () {
        it("Should register a commitment and lock the HSK (ETH) bond", async function () {
            const termsHash = ethers.id("SLA_TERMS_V1_HASHKEY");
            const collateral = ethers.parseEther("1.0");

            await expect(
                verdictCore.connect(serviceProvider).registerCommitment(client.address, termsHash, 3600, { value: collateral })
            ).to.emit(verdictCore, "CommitmentRegistered")
                .withArgs(1, serviceProvider.address, client.address, collateral);

            const commitment = await verdictCore.commitments(1);
            expect(commitment.status).to.equal(0); // 0 = ACTIVE
        });

        it("Should trigger an autonomous resolution if an SLA is breached", async function () {
            const termsHash = ethers.id("SLA_V1");
            await verdictCore.connect(serviceProvider).registerCommitment(client.address, termsHash, 3600, { value: ethers.parseEther("10.0") });

            const evidenceHash = ethers.id("ONCHAIN_OS_LOG_PROOF");

            await expect(verdictCore.connect(client).triggerResolution(1, evidenceHash))
                .to.emit(verdictCore, "DisputeTriggered")
                .withArgs(1, evidenceHash);

            const commitment = await verdictCore.commitments(1);
            expect(commitment.status).to.equal(1); // 1 = DISPUTED
        });
    });

    describe("HSP JURY EXECUTION: 3/5 Multi-Sig Resolution", function () {
        let commitmentId = 1;

        beforeEach(async function () {
            const termsHash = ethers.id("SLA_V1");
            await verdictCore.connect(serviceProvider).registerCommitment(client.address, termsHash, 3600, { value: ethers.parseEther("5.0") });
            await verdictCore.connect(client).triggerResolution(commitmentId, ethers.id("EVIDENCE_LOGS"));
        });

        it("Should successfully execute standard settlement with exactly 3 valid jury signatures", async function () {
            const outcome = 2; // 2 = RESOLVED_STANDARD (Return funds to service provider)

            // Hash: keccak256(abi.encodePacked(id, outcome))
            const payloadHash = ethers.solidityPackedKeccak256(["uint256", "uint8"], [commitmentId, outcome]);

            // Hardhat `signMessage` automatically prefixes the payload to create an Ethereum Signed Message
            const sig1 = await jury1.signMessage(ethers.getBytes(payloadHash));
            const sig2 = await jury2.signMessage(ethers.getBytes(payloadHash));
            const sig3 = await jury4.signMessage(ethers.getBytes(payloadHash));

            const signatures = [sig1, sig2, sig3];

            await expect(verdictCore.connect(deployer).executeVerdict(commitmentId, outcome, signatures))
                .to.emit(verdictCore, "VerdictExecuted");

            const c = await verdictCore.commitments(commitmentId);
            expect(c.status).to.equal(outcome);
        });

        it("Should successfully execute punishing slash with 5/5 valid jury signatures", async function () {
            const outcome = 3; // 3 = RESOLVED_SLASHED (Slash funds to Client)

            const payloadHash = ethers.solidityPackedKeccak256(["uint256", "uint8"], [commitmentId, outcome]);

            const sig1 = await jury1.signMessage(ethers.getBytes(payloadHash));
            const sig2 = await jury2.signMessage(ethers.getBytes(payloadHash));
            const sig3 = await jury3.signMessage(ethers.getBytes(payloadHash));
            const sig4 = await jury4.signMessage(ethers.getBytes(payloadHash));
            const sig5 = await jury5.signMessage(ethers.getBytes(payloadHash));

            const signatures = [sig1, sig2, sig3, sig4, sig5];

            await expect(verdictCore.connect(deployer).executeVerdict(commitmentId, outcome, signatures))
                .to.emit(verdictCore, "VerdictExecuted");
        });

        it("Should fail if there are less than 3 valid signatures (Malicious Actor)", async function () {
            const outcome = 3; // RESOLVED_SLASHED
            const payloadHash = ethers.solidityPackedKeccak256(["uint256", "uint8"], [commitmentId, outcome]);

            const sig1 = await jury1.signMessage(ethers.getBytes(payloadHash));
            // nonJuror tries to spoof the outcome
            const sig2 = await nonJuror.signMessage(ethers.getBytes(payloadHash));
            const sig3 = await jury3.signMessage(ethers.getBytes(payloadHash));

            const signatures = [sig1, sig2, sig3]; // Technically 3 signatures, but only 2 are verified jurors

            await expect(
                verdictCore.connect(deployer).executeVerdict(commitmentId, outcome, signatures)
            ).to.be.revertedWith("Insufficient valid jury signatures");
        });

        it("Should fail on duplicate valid signatures (Replay Attack)", async function () {
            const outcome = 2; // RESOLVED_STANDARD
            const payloadHash = ethers.solidityPackedKeccak256(["uint256", "uint8"], [commitmentId, outcome]);

            // jury1 signs the outcome
            const sig1 = await jury1.signMessage(ethers.getBytes(payloadHash));
            // Agent A tries to submit jury1's signature twice to fake consensus
            const sig2 = sig1;
            const sig3 = await jury3.signMessage(ethers.getBytes(payloadHash));

            const signatures = [sig1, sig2, sig3];

            await expect(
                verdictCore.connect(deployer).executeVerdict(commitmentId, outcome, signatures)
            ).to.be.revertedWith("Invalid or duplicate jury signature");
        });
    });
});
