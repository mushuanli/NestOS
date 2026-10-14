// @file: llm-ui/domain/ports/IBranchStore.ts

import type { BranchItem } from '../types';

export interface IBranchStore {
    readonly current: BranchItem[];
    readonly currentBranch: BranchItem | undefined;
    readonly count: number;
    setBranches(branches: BranchItem[]): void;
    refresh(): Promise<BranchItem[]>;
    onChange(listener: () => void): () => void;
    destroy(): void;
}
