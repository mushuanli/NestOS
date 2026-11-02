import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareWorktree} from '../src/projects/worktree-preparation';
import type {RemoteProcessHandle} from '../src/projects/remote-mounts';
const run = promisify(execFile), paths: string[] = [];
afterEach(async () => {for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});});
it('creates a real worktree with relocatable metadata and reconciles a lost creation response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestos-worktree-')); paths.push(root);
    await run('git', ['init', '-q', root]);
    await run('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    const entries = new Map<string, unknown>();
    const journal = {get: async <T>(key: string) => structuredClone(entries.get(key)) as T | undefined,
        update: async <T>(key: string, change: (old: T | undefined) => T) => {const value = change(entries.get(key) as T | undefined); entries.set(key, structuredClone(value)); return value;}};
    let lost = false, creates = 0;
    const process = {nativeShell: {exec: async (program: string, args: string[]) => {
        const result = await run(program, args.map(arg => arg.replace('/workspace', root)), {cwd: root});
        if (args[0] === 'worktree' && args[1] === 'add') {creates++; if (!lost) {lost = true; throw new Error('Response lost');}}
        return {stdout: result.stdout.replaceAll(root, '/workspace'), stderr: result.stderr, code: 0};
    }}, release: async () => {}} as RemoteProcessHandle;
    const directory = '/workspace/_nestos/worktrees/attempt';
    await expect(prepareWorktree(journal, 'attempt', directory, process)).rejects.toThrow('Response lost');
    const restored = await prepareWorktree(journal, 'attempt', directory, process);
    expect(restored.phase).toBe('ready'); expect(creates).toBe(1);
    const gitFile = await readFile(join(root, '_nestos/worktrees/attempt/.git'), 'utf8');
    expect(gitFile).toMatch(/^gitdir: \.\.\//);
    expect((await run('git', ['-C', join(root, '_nestos/worktrees/attempt'), 'rev-parse', 'HEAD'])).stdout.trim()).toBe(restored.baseCommit);
});
