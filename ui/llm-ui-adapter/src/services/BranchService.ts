// @file: llm-ui/services/BranchService.ts


import { SessionCommand, type SessionGroup } from '@itookit/llm-session/contracts';
import type { BranchItem } from '../domain/types';
import type { IBranchStore } from '../domain/ports/IBranchStore';
import type { ICommandBus } from '@itookit/llm-session/contracts';


export class BranchError extends Error {
    constructor(
        public code: 'NOT_FOUND' | 'ALREADY_CURRENT' | 'CANNOT_DELETE_CURRENT'
            | 'NO_OTHER' | 'NO_CURRENT' | 'INVALID_NAME',
        message: string,
    ) {
        super(message);
        this.name = 'BranchError';
    }
}

/**
 * Branch 领域服务 — 封装所有分支业务逻辑
 *
 * 职责：
 * - 参数校验（统一入口，消除 Slash/Command/FloatingNav 中的重复）
 * - 通过 ICommandBus 执行引擎操作
 * - 不涉及 UI（无 DOM、无 Toast）
 *
 * Commands 和 Slash 回调通过此服务操作分支，
 * 错误由调用方处理（Toast 等 UI 反馈）。
 */
export class BranchService {
    constructor(
        private commands: ICommandBus,
        private branchStore: IBranchStore,
    ) {}

    get list(): BranchItem[] { return this.branchStore.current; }

    // ── Create ──────────────────────────────────────────

    async create(sourceNodeId: string, name: string): Promise<void> {
        const branchPoint = await this.findBranchPoint(sourceNodeId);
        const newNodeId = await this.commands.execute<string>('vcs.branch.create', {
            branchNodeId: branchPoint,
            options: { name: name || undefined, copyContent: true },
        });
        const branches = await this.commands.execute<Array<{ name: string; headNodeId: string; isCurrent: boolean }>>('vcs.branch.list');
        const branch = branches.find(b => b.headNodeId === newNodeId);
        if (branch) {
            await this.commands.execute('vcs.branch.switch', { branchName: branch.name });
        }
    }

    // ── Switch ─────────────────────────────────────────

    /** 精确匹配切换 */
    async switch(branchName: string): Promise<void> {
        const target = this.branchStore.current.find(b => b.name === branchName);
        if (!target) throw new BranchError('NOT_FOUND', `Branch "${branchName}" does not exist`);
        if (target.isCurrent) throw new BranchError('ALREADY_CURRENT', `Already on branch "${branchName}"`);
        await this.commands.execute('vcs.branch.switch', { branchName });
    }

    /** 大小写不敏感匹配切换（供 Slash 命令 / FloatingNav 使用） */
    async switchFuzzy(name: string): Promise<void> {
        const lower = name.toLowerCase();
        const target = this.branchStore.current.find(b => b.name.toLowerCase() === lower);
        if (!target) throw new BranchError('NOT_FOUND', `Branch "${name}" does not exist`);
        await this.switch(target.name);
    }

    /** 按 headNodeId 切换 */
    async switchById(headNodeId: string): Promise<void> {
        const branches = await this.commands.execute<Array<{ name: string; headNodeId: string }>>('vcs.branch.list');
        const branch = branches.find(b => b.headNodeId === headNodeId);
        if (!branch) throw new BranchError('NOT_FOUND', `No branch found for head node: ${headNodeId}`);
        await this.commands.execute('vcs.branch.switch', { branchName: branch.name });
    }

    /** 按偏移量切换（快捷键 Cmd+Shift+[/] ) */
    async switchByOffset(offset: number, cachedBranches: BranchItem[]): Promise<void> {
        if (cachedBranches.length <= 1) throw new BranchError('NO_OTHER', 'No other branches to switch to');
        const currentIndex = cachedBranches.findIndex(b => b.isCurrent);
        if (currentIndex === -1) return;
        const len = cachedBranches.length;
        const newIndex = ((currentIndex + offset) % len + len) % len;
        if (newIndex === currentIndex) return;
        await this.commands.execute('vcs.branch.switch', { branchName: cachedBranches[newIndex].name });
    }

    // ── Rename ─────────────────────────────────────────

    async rename(oldName: string, newName: string): Promise<void> {
        if (!newName.trim()) throw new BranchError('INVALID_NAME', 'Branch name cannot be empty');
        const lower = oldName.toLowerCase();
        const target = this.branchStore.current.find(b => b.name.toLowerCase() === lower);
        if (!target) throw new BranchError('NOT_FOUND', `Branch "${oldName}" does not exist`);
        await this.commands.execute('vcs.branch.rename', { oldName: target.name, newName });
    }

    // ── Delete ─────────────────────────────────────────

    async delete(branchName: string): Promise<void> {
        const lower = branchName.toLowerCase();
        const target = this.branchStore.current.find(b => b.name.toLowerCase() === lower);
        if (!target) throw new BranchError('NOT_FOUND', `Branch "${branchName}" does not exist`);
        if (target.isCurrent) throw new BranchError('CANNOT_DELETE_CURRENT',
            'Cannot delete the current branch. Switch to another branch first.');
        await this.commands.execute('vcs.branch.delete', { branchName: target.name });
    }

    // ── Helpers ────────────────────────────────────────

    private async findBranchPoint(sourceNodeId: string): Promise<string> {
        const sessions = await this.commands.execute<SessionGroup[]>(SessionCommand.GetSessions);
        const idx = sessions.findIndex(s => s.id === sourceNodeId);
        if (idx === -1) return sourceNodeId;
        const session = sessions[idx];
        if (session.role !== 'user') return sourceNodeId;
        return idx > 0 ? sessions[idx - 1].id : sourceNodeId;
    }
}
