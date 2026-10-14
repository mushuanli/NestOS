import { describe, expect, it } from 'vitest';
import { GitWorktreeFlowWorkspaceManager } from '../src/flow/git-worktree-manager';

/** Stateful fake git so prepare/restore/finish observe each other's effects. */
function fakeGit(initial: { worktrees?: string[]; branches?: string[]; status?: string } = {}) {
    const worktrees = new Set(initial.worktrees ?? []);
    const branches = new Set(initial.branches ?? []);
    const calls: Array<{ program: string; args: string[]; cwd: string }> = [];
    return {
        calls, worktrees, branches,
        commands: {
            async run(program: string, args: string[], options: { cwd: string }) {
                calls.push({ program, args, cwd: options.cwd });
                if (args[0] === 'worktree' && args[1] === 'add') worktrees.add(args[4]);
                if (args[0] === 'worktree' && args[1] === 'remove') worktrees.delete(args[args.length - 1]);
                if (args[0] === 'branch' && args[1] === '-D') branches.delete(args[2]);
                if (args[0] === 'rev-parse' && !branches.has(String(args[3]).replace('refs/heads/', ''))) {
                    throw new Error('unknown revision');
                }
                if (args[0] === 'worktree' && args[1] === 'list') {
                    return { stdout: [...worktrees].map(directory => `worktree ${directory}\n`).join('') };
                }
                if (args[0] === 'status') return { stdout: initial.status ?? '' };
                return { stdout: '' };
            },
        },
    };
}

describe('GitWorktreeFlowWorkspaceManager', () => {
    it('creates, fast-forwards and cleans an isolated worktree using argv-safe commands', async () => {
        const git = fakeGit({ branches: [] });
        const manager = new GitWorktreeFlowWorkspaceManager({
            repository: '/repo', directoryFor: sessionId => `/worktrees/${sessionId}`, commands: git.commands,
        });

        const lease = await manager.prepare('run with spaces', {
            mode: 'worktree', base: 'head', merge: 'auto-if-clean', cleanup: 'always',
        });
        expect(lease.record).toEqual({ version: 1, directory: '/worktrees/run with spaces', branch: expect.stringContaining('flow/run-with-spaces-') });
        git.branches.add((lease.record as { branch: string }).branch);
        await lease.finish('succeeded');
        await lease.finish('succeeded');

        expect(lease.directory).toBe('/worktrees/run with spaces');
        expect(git.calls[0].args.slice(0, 3)).toEqual(['worktree', 'add', '-b']);
        expect(git.calls.some(call => call.args[0] === 'merge' && call.args[1] === '--ff-only')).toBe(true);
        expect(git.calls.some(call => call.args.slice(0, 2).join(' ') === 'worktree remove')).toBe(true);
        expect(git.worktrees.size).toBe(0);
        expect(git.calls.every(call => call.program === 'git')).toBe(true);
    });

    it('refuses automatic merge when the worktree has uncommitted changes', async () => {
        const git = fakeGit({ worktrees: ['/worktree'], branches: ['flow/run-1'], status: ' M file.ts' });
        const manager = new GitWorktreeFlowWorkspaceManager({
            repository: '/repo', directoryFor: () => '/worktree', commands: git.commands,
        });
        const lease = await manager.prepare('run', { mode: 'worktree', merge: 'auto-if-clean', cleanup: 'always' });
        await expect(lease.finish('succeeded')).rejects.toThrow('workspace: /worktree; branch: flow/run-');
        expect(git.worktrees.has('/worktree')).toBe(true);
    });

    it('reports a retained workspace and branch for manual recovery after cancellation', async () => {
        const git = fakeGit();
        const manager = new GitWorktreeFlowWorkspaceManager({ repository: '/repo', directoryFor: () => '/worktree', commands: git.commands });
        const lease = await manager.prepare('run', { mode: 'worktree', merge: 'manual', cleanup: 'on-success' });
        const result = await lease.finish('cancelled');
        expect(result?.message).toContain('Retained workspace: /worktree; Retained branch: flow/run-');
        expect(result?.message).toContain('repository: /repo');
        expect(await lease.finish('cancelled')).toEqual(result);
        expect(git.worktrees.has('/worktree')).toBe(true);
        const restored = await manager.restore('run', { mode: 'worktree', merge: 'manual', cleanup: 'on-success' }, lease.record!);
        expect(await restored.finish('cancelled')).toEqual(result);
    });

    it('restores a recorded worktree lease in a new host and finalizes it', async () => {
        const record = { version: 1 as const, directory: '/worktrees/run', branch: 'flow/run-abc' };
        const git = fakeGit({ worktrees: [record.directory], branches: [record.branch] });
        const manager = new GitWorktreeFlowWorkspaceManager({
            repository: '/repo', directoryFor: () => record.directory, commands: git.commands,
        });

        const lease = await manager.restore('run', { mode: 'worktree', merge: 'discard', cleanup: 'always' }, record);
        expect(lease.directory).toBe(record.directory);
        expect(lease.record).toEqual(record);
        // A restored lease must not create a second worktree.
        expect(git.calls.some(call => call.args[1] === 'add')).toBe(false);

        await lease.finish('failed');
        expect(git.worktrees.size).toBe(0);
        expect(git.branches.size).toBe(0);
    });

    it('finishes a finalization whose worktree was already removed by the previous host', async () => {
        const record = { version: 1 as const, directory: '/worktrees/run', branch: 'flow/run-abc' };
        const git = fakeGit({ worktrees: [record.directory], branches: [record.branch] });
        const manager = new GitWorktreeFlowWorkspaceManager({
            repository: '/repo', directoryFor: () => record.directory, commands: git.commands,
        });
        const lease = await manager.restore('run', { mode: 'worktree', merge: 'discard', cleanup: 'always' }, record);
        git.worktrees.clear();
        git.branches.clear();
        await expect(lease.finish('succeeded')).resolves.toBeUndefined();
        expect(git.calls.some(call => call.args.slice(0, 2).join(' ') === 'worktree remove')).toBe(false);
    });

    it.each(['discard', 'auto-if-clean'] as const)('restores finalization after worktree removal before host restart (%s)', async merge => {
        const record = { version: 1, directory: '/worktrees/run', branch: 'flow/run-abc' };
        const git = fakeGit({ branches: [record.branch] });
        const manager = new GitWorktreeFlowWorkspaceManager({
            repository: '/repo', directoryFor: () => record.directory, commands: git.commands,
        });
        const policy = { mode: 'worktree' as const, merge, cleanup: 'always' as const };
        await expect(manager.restore('run', policy, record)).rejects.toThrow('Worktree is missing');
        const restored = await manager.restore('run', policy, record, { forFinalization: true });
        await restored.finish('succeeded');
        expect(git.branches.size).toBe(0);
        expect(git.calls.some(call => call.args[0] === 'status' || call.args[1] === 'remove')).toBe(false);
    });

    it.each(['keep', 'on-success'] as const)('does not report a missing retained worktree as cleaned (%s)', async cleanup => {
        const git = fakeGit();
        const manager = new GitWorktreeFlowWorkspaceManager({ repository: '/repo', directoryFor: () => '/worktrees/run', commands: git.commands });
        const restored = await manager.restore('run', { mode: 'worktree', cleanup },
            { version: 1, directory: '/worktrees/run', branch: 'flow/run' }, { forFinalization: true });
        await expect(restored.finish('failed')).rejects.toThrow('retention policy is missing');
        expect(git.calls.some(call => call.args[0] === 'merge' || call.args[0] === 'branch')).toBe(false);
    });

    it('does not mistake a longer sibling path for the recorded worktree', async () => {
        const git = fakeGit({ worktrees: ['/worktrees/run-other'] });
        const manager = new GitWorktreeFlowWorkspaceManager({ repository: '/repo', directoryFor: () => '/worktrees/run', commands: git.commands });
        await expect(manager.restore('run', { mode: 'worktree' }, { version: 1, directory: '/worktrees/run', branch: 'flow/run' }))
            .rejects.toThrow('Worktree is missing');
    });

    it('rejects a lease that belongs to another Session or lost its worktree', async () => {
        const git = fakeGit({ worktrees: ['/worktrees/other'], branches: ['flow/other'] });
        const manager = new GitWorktreeFlowWorkspaceManager({
            repository: '/repo', directoryFor: () => '/worktrees/run', commands: git.commands,
        });
        await expect(manager.restore('run', { mode: 'worktree' },
            { version: 1, directory: '/worktrees/other', branch: 'flow/other' })).rejects.toThrow('does not belong');
        await expect(manager.restore('run', { mode: 'worktree' },
            { version: 1, directory: '/worktrees/run', branch: 'flow/run' })).rejects.toThrow('Worktree is missing');
        await expect(manager.restore('run', { mode: 'worktree' }, { version: 1 } as never)).rejects.toThrow('Invalid worktree lease record');
    });
});
