// @file: llm-ui/services/BranchStore.ts

import type { BranchItem } from '../domain/types';
import type { IBranchStore } from '../domain/ports/IBranchStore';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { ErrorHandler } from '../utils/errorHandler';

/**
 * Branch 数据的唯一真实来源
 *
 * 层级：Service（数据管理，不涉及 UI）
 * 性能：合并并发请求，脏检查避免无意义通知
 */
export class BranchStore implements IBranchStore {
    private branches: BranchItem[] = [
        { name: 'main', headNodeId: '', isCurrent: true }
    ];
    private listeners = new Set<() => void>();
    private refreshPromise: Promise<BranchItem[]> | null = null;

    constructor(
        private commands: ICommandBus,
        private errorHandler: ErrorHandler
    ) {}

    // 只读访问
    get current(): BranchItem[] { return [...this.branches]; }
    get currentBranch(): BranchItem | undefined { return this.branches.find(b => b.isCurrent); }
    get count(): number { return this.branches.length; }

    setBranches(branches: BranchItem[]): void {
        if (this.isEqual(this.branches, branches)) return;
        this.branches = [...branches];
        this.notify();
    }

    /**
     * 刷新 — 合并并发请求
     */
    async refresh(): Promise<BranchItem[]> {
        if (this.refreshPromise) return this.refreshPromise;

        this.refreshPromise = this.doRefresh();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    private async doRefresh(): Promise<BranchItem[]> {
        const raw = await this.errorHandler.wrapWithFallback(
            () => this.commands.execute<Array<{ name: string; headNodeId: string; isCurrent: boolean }>>('vcs.branch.list'), [],
            'Refresh branches', 'warn'
        );

        const newBranches: BranchItem[] = raw.length === 0
            ? [{ name: 'main', headNodeId: '', isCurrent: true }]
            : raw.map(b => ({ name: b.name, headNodeId: b.headNodeId, isCurrent: b.isCurrent }));

        this.setBranches(newBranches);

        return this.branches;
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void { this.listeners.forEach(fn => fn()); }

    private isEqual(a: BranchItem[], b: BranchItem[]): boolean {
        if (a.length !== b.length) return false;
        return a.every((item, i) =>
            item.name === b[i].name &&
            item.headNodeId === b[i].headNodeId &&
            item.isCurrent === b[i].isCurrent
        );
    }

    destroy(): void {
        this.listeners.clear();
        this.branches = [];
        this.refreshPromise = null;
    }
}
