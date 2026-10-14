import type { JsonValue } from '@itookit/durable-kernel';
import type { FlowWorkspacePolicy } from '../contracts';
import type { FlowWorkspaceLease, FlowWorkspaceManager, FlowWorkspaceRestoreOptions } from './executor';

export interface WorkspaceCommandRunner {
    run(program: string, args: string[], options: { cwd: string }): Promise<{ stdout?: string }>;
}

export interface GitWorktreeManagerOptions {
    repository: string;
    directoryFor(sessionId: string): string;
    commands: WorkspaceCommandRunner;
    /** Persist host recovery intent before Git can create either a branch or a directory. */
    beforeCreate?(record: JsonValue): Promise<void>;
}

/** Durable lease record: enough to re-attach the worktree in a new host process. */
interface WorktreeLeaseRecord {
    version: 1;
    directory: string;
    branch: string;
}

/**
 * Host-neutral Git worktree implementation. Commands are argv arrays (never a
 * shell string), so the desktop/CLI host can apply its normal sandbox policy.
 */
export class GitWorktreeFlowWorkspaceManager implements FlowWorkspaceManager {
    constructor(private readonly options: GitWorktreeManagerOptions) {}

    async prepare(sessionId: string, policy: FlowWorkspacePolicy): Promise<FlowWorkspaceLease> {
        if (policy.mode !== 'worktree') {
            throw new Error(`Git worktree manager does not implement workspace mode ${policy.mode}`);
        }
        const directory = this.options.directoryFor(sessionId);
        const branch = `flow/${safeName(sessionId)}-${Date.now().toString(36)}`;
        const base = policy.base === 'current' || policy.base === 'head' || policy.base === undefined ? 'HEAD' : policy.base;
        await this.options.beforeCreate?.({ version: 1, directory, branch });
        await this.git(['worktree', 'add', '-b', branch, directory, base]);
        return this.lease({ version: 1, directory, branch }, policy);
    }

    async restore(sessionId: string, policy: FlowWorkspacePolicy, record: JsonValue, options?: FlowWorkspaceRestoreOptions): Promise<FlowWorkspaceLease> {
        if (policy.mode !== 'worktree') {
            throw new Error(`Git worktree manager does not implement workspace mode ${policy.mode}`);
        }
        const saved = parseRecord(record);
        if (saved.directory !== this.options.directoryFor(sessionId)) {
            throw new Error('Worktree lease does not belong to this Session');
        }
        if (!options?.forFinalization && !await this.hasWorktree(saved.directory)) {
            throw new Error(`Worktree is missing: ${saved.directory}`);
        }
        return this.lease(saved, policy);
    }

    private lease(saved: WorktreeLeaseRecord, policy: FlowWorkspacePolicy): FlowWorkspaceLease {
        let finished = false, result: void | { message: string };
        return {
            directory: saved.directory,
            record: { version: 1, directory: saved.directory, branch: saved.branch },
            finish: async status => {
                if (finished) return result;
                try { await this.finishWorkspace(saved, policy, status); }
                catch (error) {
                    throw new Error(`${error instanceof Error ? error.message : String(error)}; workspace: ${saved.directory}; branch: ${saved.branch}. Review the retained changes before retrying cleanup.`, { cause: error });
                }
                const retained = policy.cleanup === 'keep' || ((policy.cleanup ?? 'on-success') === 'on-success' && status !== 'succeeded');
                if (retained || (policy.merge ?? 'manual') === 'manual') result = { message:
                    `${retained ? `Retained workspace: ${saved.directory}; ` : ''}Retained branch: ${saved.branch}; repository: ${this.options.repository}. Review and merge changes manually when ready.` };
                finished = true;
                return result;
            },
        };
    }

    private async finishWorkspace(saved: WorktreeLeaseRecord, policy: FlowWorkspacePolicy,
        status: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
        const { directory, branch } = saved;
        const present = await this.hasWorktree(directory);
        const cleanup = policy.cleanup ?? 'on-success';
        if (!present && (cleanup === 'keep' || (cleanup === 'on-success' && status !== 'succeeded'))) {
            throw new Error(`Worktree required by retention policy is missing: ${directory}`);
        }
        const merge = policy.merge ?? 'manual';
        if (status === 'succeeded' && merge === 'auto-if-clean') {
            if (present) await this.assertClean(directory);
            if (await this.branchExists(branch)) await this.git(['merge', '--ff-only', branch]);
        }
        if (cleanup === 'keep' || (cleanup === 'on-success' && status !== 'succeeded')) return;
        // Cleanup may have removed the directory before the old host persisted completion.
        if (present) await this.git(['worktree', 'remove', ...(status === 'succeeded' && merge !== 'discard' ? [] : ['--force']), directory]);
        if ((merge === 'discard' || merge === 'auto-if-clean') && await this.branchExists(branch)) {
            await this.git(['branch', '-D', branch]);
        }
    }

    private async assertClean(directory: string): Promise<void> {
        const state = await this.options.commands.run('git', ['status', '--porcelain'], { cwd: directory });
        if (state.stdout?.trim()) throw new Error('Worktree has uncommitted changes; automatic merge was refused');
    }

    private async listedWorktrees(): Promise<string> {
        return (await this.git(['worktree', 'list', '--porcelain'])).stdout ?? '';
    }

    private async hasWorktree(directory: string): Promise<boolean> {
        return (await this.listedWorktrees()).split('\n').includes(`worktree ${directory}`);
    }

    private async branchExists(branch: string): Promise<boolean> {
        try {
            await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
            return true;
        } catch { return false; }
    }

    private async git(args: string[]): Promise<{ stdout?: string }> {
        return this.options.commands.run('git', args, { cwd: this.options.repository });
    }
}

function parseRecord(value: JsonValue): WorktreeLeaseRecord {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, JsonValue> : {};
    const directory = record.directory, branch = record.branch;
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Invalid worktree lease record: directory');
    if (typeof branch !== 'string' || !branch.trim()) throw new Error('Invalid worktree lease record: branch');
    return { version: 1, directory, branch };
}

function safeName(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'run';
}
