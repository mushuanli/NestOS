import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TauriWorkspaceGitRunner } from '../../../apps/tauri-app/src/shell/workspace-git';
import { GitWorktreeFlowWorkspaceManager } from '../../../backend/llm-flow/src/flow/git-worktree-manager';

const invoke = vi.fn();
beforeEach(() => {
    invoke.mockReset().mockImplementation(async (command, args) => {
        if (command === 'directory_open') return { id: `grant:${args.path}` };
        if (command === 'git_command') return ['output', '', 0];
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => invoke(command, args) } });
});
afterEach(() => vi.unstubAllGlobals());
const runner = () => new TauriWorkspaceGitRunner('/repo', '/data/worktrees/run');

it('passes directory capabilities for creation and releases both after the command', async () => {
    const args = ['worktree', 'add', '-b', 'flow/run', '/data/worktrees/run', 'HEAD'];
    expect(await runner().run('git', args, { cwd: '/repo' })).toEqual({ stdout: 'output' });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(['directory_open', 'directory_open', 'git_command', 'directory_close', 'directory_close']);
    expect(invoke).toHaveBeenCalledWith('git_command', {
        repositoryId: 'grant:/repo', workspaceId: 'grant:/data/worktrees', args, timeoutMs: 30_000,
    });
    expect(invoke).toHaveBeenCalledWith('directory_close', { id: 'grant:/repo' });
    expect(invoke).toHaveBeenCalledWith('directory_close', { id: 'grant:/data/worktrees' });
});

it('allows status in the isolated copy without opening a destination grant', async () => {
    await runner().run('git', ['status', '--porcelain'], { cwd: '/data/worktrees/run' });
    expect(invoke.mock.calls.filter(([name]) => name === 'directory_open')).toEqual([['directory_open', { path: '/data/worktrees/run' }]]);
    expect(invoke).toHaveBeenCalledWith('git_command', expect.objectContaining({ repositoryId: 'grant:/data/worktrees/run', workspaceId: undefined }));
});

it('rejects unrelated programs, directories and worktree targets before acquiring grants', async () => {
    for (const [program, args, cwd] of [
        ['sh', [], '/repo'], ['git', ['status', '--porcelain'], '/other'],
        ['git', ['worktree', 'remove', '/data/worktrees/other'], '/repo'],
        ['git', ['worktree', 'remove', '/data/worktrees/run/../other'], '/repo'],
    ] as Array<[string, string[], string]>) await expect(runner().run(program, args, { cwd })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
});

it('closes the first grant when acquiring the destination fails', async () => {
    invoke.mockImplementation(async (command, args) => {
        if (command === 'directory_open' && args.path !== '/repo') throw new Error('destination unavailable');
        return { id: 'repository' };
    });
    await expect(runner().run('git', ['worktree', 'remove', '/data/worktrees/run'], { cwd: '/repo' })).rejects.toThrow('destination unavailable');
    expect(invoke).toHaveBeenCalledWith('directory_close', { id: 'repository' });
    expect(invoke.mock.calls.some(([name]) => name === 'git_command')).toBe(false);
});

it('preserves the Git failure and every grant cleanup failure', async () => {
    invoke.mockImplementation(async (command, args) => {
        if (command === 'directory_open') return { id: args.path };
        if (command === 'git_command') return ['', 'worktree is dirty', 128];
        throw new Error(`close:${args.id}`);
    });
    const error = await runner().run('git', ['worktree', 'remove', '/data/worktrees/run'], { cwd: '/repo' }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((item: Error) => item.message)).toEqual([
        'Git exited with code 128: worktree is dirty', 'close:/repo', 'close:/data/worktrees',
    ]);
});

it('runs the shared worktree manager through the actual Tauri adapter', async () => {
    const worktrees = new Set<string>();
    invoke.mockImplementation(async (command, params) => {
        if (command === 'directory_open') return { id: `grant:${params.path}` };
        if (command !== 'git_command') return;
        const args = params.args;
        if (args[0] === 'worktree' && args[1] === 'add') worktrees.add(args[4]);
        if (args[0] === 'worktree' && args[1] === 'remove') worktrees.delete(args.at(-1));
        return [args[1] === 'list' ? [...worktrees].map(path => `worktree ${path}\n`).join('') : '', '', 0];
    });
    const manager = new GitWorktreeFlowWorkspaceManager({ repository: '/repo', directoryFor: () => '/data/worktrees/run', commands: runner() });
    const lease = await manager.prepare('s', { mode: 'worktree' });
    expect(worktrees.has(lease.directory)).toBe(true);
    await lease.finish('succeeded');
    expect(worktrees.size).toBe(0);
    const opens = invoke.mock.calls.filter(([name]) => name === 'directory_open');
    const closes = invoke.mock.calls.filter(([name]) => name === 'directory_close');
    expect(closes).toHaveLength(opens.length);
});
