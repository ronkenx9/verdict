import fs from "node:fs";
import path from "node:path";

import type { Address } from "viem";

import type { ResolverState } from "./types";

export interface ResolverStore {
  load(): Promise<ResolverState>;
  save(state: ResolverState): Promise<void>;
  initialize?(): Promise<void>;
  describe(): string;
}

export class FileResolverStore implements ResolverStore {
  constructor(
    private readonly filePath: string,
    private readonly chainId: number,
    private readonly contractAddress: Address,
    private readonly deploymentBlock: bigint
  ) {}

  async load(): Promise<ResolverState> {
    if (!fs.existsSync(this.filePath)) {
      return this.createInitialState();
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as ResolverState;

    if (parsed.chainId !== this.chainId) {
      throw new Error(
        `Resolver state chain mismatch: expected ${this.chainId}, found ${parsed.chainId}`
      );
    }

    if (parsed.contractAddress.toLowerCase() !== this.contractAddress.toLowerCase()) {
      throw new Error(
        `Resolver state contract mismatch: expected ${this.contractAddress}, found ${parsed.contractAddress}`
      );
    }

    return parsed;
  }

  async save(state: ResolverState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  describe() {
    return this.filePath;
  }

  private createInitialState(): ResolverState {
    const now = new Date().toISOString();
    return {
      version: 1,
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      createdAt: now,
      updatedAt: now,
      indexer: {
        deploymentBlock: this.deploymentBlock.toString(),
        lastIndexedBlock: (this.deploymentBlock - 1n).toString(),
      },
      slas: {},
      jobs: {},
      metrics: {
        indexedRegistrations: 0,
        indexedResolutions: 0,
        reconciliationPasses: 0,
        queuedJobs: 0,
        successfulResolutions: 0,
        failedAttempts: 0,
        deadLetters: 0,
      },
    };
  }
}
