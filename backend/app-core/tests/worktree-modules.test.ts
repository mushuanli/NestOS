import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareWorktree} from '../src/projects/worktree-preparation';
import {prepareWorktreeModules, verifyWorktreeDelivery} from '../src/projects/worktree-modules';
import type {RemoteProcessHandle} from '../src/projects/remote-mounts';
const run = promisify(execFile), paths: string[] = [];
afterEach(async () => {for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'nestos-module-')); paths.push(root);
    const git = async (cwd: string, args: string[]) => (await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {cwd})).stdout.trim();
    await run('git', ['init', '-q', join(root, 'source')]); await git(join(root, 'source'), ['commit', '--allow-empty', '-qm', 'base']);
    await run('git', ['init', '-q', join(root, 'project')]);
    const project = join(root, 'project');
    await writeFile(join(project, '.gitignore'), '_nestos/\n');
    await git(project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', join(root, 'source'), 'module']);
    await git(project, ['add', '.']); await git(project, ['commit', '-qm', 'base']);
    const entries = new Map<string, unknown>();
    const journal = {get: async <T>(key: string) => structuredClone(entries.get(key)) as T | undefined,
        update: async <T>(key: string, change: (old: T | undefined) => T) => {const value = change(entries.get(key) as T | undefined); entries.set(key, structuredClone(value)); return value;}};
    let lost = false;
    const process = {nativeShell: {exec: async (program: string, args: string[], options: {cwd: string}) => {
        const actual = args.map(arg => arg.replaceAll('/workspace', project));
        try {
            const result = await run(program, ['-c', 'protocol.file.allow=always', ...actual], {cwd: options.cwd.replace('/workspace', project)});
            if (args[0] === 'switch' && !lost) {lost = true; throw new Error('Response lost');}
            return {stdout: result.stdout.replaceAll(project, '/workspace'), stderr: result.stderr, code: 0};
        } catch (error) {
            const e = error as {code?: number; stdout?: string; stderr?: string};
            if (typeof e.code !== 'number') throw error;
            return {stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code};
        }
    }}} as RemoteProcessHandle;
    const tree = await prepareWorktree(journal, 'attempt', '/workspace/_nestos/worktrees/attempt', process);
    return {root: project, git, journal, process, tree, work: join(project, '_nestos/worktrees/attempt')};
}
it('prepares a separate module branch, recovers a lost switch response and verifies both commit modes', async () => {
    const f = await fixture();
    await expect(prepareWorktreeModules(f.journal, f.tree, ['module'], f.process)).rejects.toThrow('Response lost');
    const repositories = await prepareWorktreeModules(f.journal, f.tree, ['module'], f.process);
    expect(repositories.map(row => row.branch)).toEqual(['work/attempt', 'work/attempt']);
    expect(await f.git(join(f.root, 'module'), ['branch', '--show-current'])).not.toBe('work/attempt');
    expect(await verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'changes')).toHaveLength(2);
    await writeFile(join(f.work, 'module', 'feature.txt'), 'feature');
    const dirty = await verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'changes');
    expect(dirty[1].dirty).toBe(true); expect(dirty[1].changesDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'worktree')).rejects.toMatchObject({code: 'DELIVERY_UNCOMMITTED_CHANGES'});
    await f.git(join(f.work, 'module'), ['add', '.']); await f.git(join(f.work, 'module'), ['commit', '-qm', 'feature']);
    await f.git(f.work, ['add', 'module']); await f.git(f.work, ['commit', '-qm', 'module pointer']);
    await expect(verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'changes')).rejects.toMatchObject({code: 'UNAUTHORIZED_COMMIT'});
    expect((await verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'worktree')).every(row => !row.dirty)).toBe(true);
});
it('detects content changes in uncommitted delivery and rejects a detached module branch', async () => {
    const f = await fixture();
    await expect(prepareWorktreeModules(f.journal, f.tree, ['module'], f.process)).rejects.toThrow('Response lost');
    const repositories = await prepareWorktreeModules(f.journal, f.tree, ['module'], f.process);
    const path = join(f.work, 'module', 'uncommitted.txt');
    await writeFile(path, 'first');
    const before = await verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'changes');
    await writeFile(path, 'other');
    const after = await verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'changes');
    expect(after[1].head).toBe(before[1].head); expect(after[1].changesDigest).not.toBe(before[1].changesDigest);
    await f.git(join(f.work, 'module'), ['switch', '--detach']);
    await expect(verifyWorktreeDelivery(f.process, f.tree.directory, repositories, 'changes')).rejects.toMatchObject({code: 'DELIVERY_BRANCH_CHANGED'});
});

it('keeps initialized submodules usable when the project root changes namespaces', async () => {
    const f = await fixture();
    await expect(prepareWorktreeModules(f.journal, f.tree, ['module'], f.process)).rejects.toThrow('Response lost');
    const repositories = await prepareWorktreeModules(f.journal, f.tree, ['module'], f.process);
    const relocated = f.root + '-relocated'; await rename(f.root, relocated);
    const module = join(relocated, '_nestos/worktrees/attempt/module');
    expect(await f.git(module, ['rev-parse', 'HEAD'])).toBe(repositories[1].baseCommit);
    expect(await f.git(module, ['branch', '--show-current'])).toBe('work/attempt');
});
it('registers module candidates without cloning and verifies lazily prepared branches', async () => {
    const f = await fixture();
    const {availableWorktreeModules} = await import('../src/projects/worktree-modules');
    const available = await availableWorktreeModules(f.process, f.tree);
    const prepared = await prepareWorktreeModules(f.journal, f.tree, [], f.process);
    expect(prepared).toHaveLength(1); expect(available[0].path).toBe('module');
    await expect(prepareWorktreeModules(f.journal, f.tree, ['module'], f.process)).rejects.toThrow('Response lost');
    await writeFile(join(f.work, 'module', 'feature.txt'), 'feature');
    await expect(verifyWorktreeDelivery(f.process, f.tree.directory, prepared, 'changes')).rejects.toMatchObject({code: 'UNDECLARED_MODULE_CHANGED'});
    const evidence = await verifyWorktreeDelivery(f.process, f.tree.directory, prepared, 'changes', available);
    expect(evidence).toHaveLength(2); expect(evidence[1].branch).toBe('work/attempt');
});

it('initializes a pinned unpublished module commit from the original project checkout', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'module', 'unpublished.txt'), 'local-only');
    await f.git(join(f.root, 'module'), ['add', '.']);
    await f.git(join(f.root, 'module'), ['commit', '-qm', 'unpublished']);
    await f.git(f.root, ['add', 'module']);await f.git(f.root, ['commit', '-qm', 'pin unpublished']);
    const tree=await prepareWorktree(f.journal,'local-pin','/workspace/_nestos/worktrees/local-pin',f.process);
    await expect(prepareWorktreeModules(f.journal,tree,['module'],f.process)).rejects.toThrow('Response lost');
    const rows=await prepareWorktreeModules(f.journal,tree,['module'],f.process);
    expect(await f.git(join(f.root,'_nestos/worktrees/local-pin/module'),['rev-parse','HEAD'])).toBe(rows[1].baseCommit);
});
