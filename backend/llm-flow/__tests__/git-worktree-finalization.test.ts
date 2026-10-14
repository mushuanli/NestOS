import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { GitWorktreeFlowWorkspaceManager } from '../src/flow/git-worktree-manager';

const execute = promisify(execFile);
it.each([['discard', true], ['auto-if-clean', true], ['discard', false]] as const)(
    'finalizes a real Git worktree (%s, previously removed: %s)', async (merge, removed) => {
    const directory = await mkdtemp(join(tmpdir(), 'mindos-worktree-finalize-'));
    const repository = join(directory, 'repo'), workspace = join(directory, 'copy');
    const commands = { run: async (program: string, args: string[], options: { cwd: string }) => execute(program, args, options) };
    const git = (args: string[]) => commands.run('git', args, { cwd: repository });
    try {
        await mkdir(repository); await git(['init', '-q']);
        await writeFile(join(repository, 'file.txt'), 'committed content');
        await git(['add', 'file.txt']);
        await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial']);
        const options = { repository, directoryFor: () => workspace, commands };
        const policy = { mode: 'worktree' as const, merge, cleanup: 'always' as const };
        const lease = await new GitWorktreeFlowWorkspaceManager(options).prepare('s', policy);
        const branch = (lease.record as { branch: string }).branch;
        // The old host removed the worktree, then disappeared before dropping the branch/status.
        if (removed) await git(['worktree', 'remove', workspace]);
        else await writeFile(join(workspace, 'file.txt'), 'uncommitted workspace change');
        const reopened = new GitWorktreeFlowWorkspaceManager(options);
        if (removed) await expect(reopened.restore('s', policy, lease.record!)).rejects.toThrow('Worktree is missing');
        const finalization = await reopened.restore('s', policy, lease.record!, { forFinalization: true });
        await finalization.finish('succeeded');
        expect((await git(['worktree', 'list', '--porcelain'])).stdout).not.toContain(`worktree ${workspace}`);
        await expect(git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).rejects.toThrow();
        expect((await git(['show', 'HEAD:file.txt'])).stdout).toBe('committed content');
    } finally { await rm(directory, { recursive: true, force: true }); }
});
