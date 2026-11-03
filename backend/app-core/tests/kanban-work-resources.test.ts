import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {developmentWorkResources} from '../src/presets/kanban-work-resources';
import {inspectWorktree, worktreeBlockers} from '../src/projects/worktree-status';

const native = vi.hoisted(() => ({reasons: [] as string[]}));
vi.mock('../src/presets/kanban-work-resource-execution', () => ({workResourceExecution: vi.fn(async () => native.reasons)}));
const exec = promisify(execFile), closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); native.reasons = [];});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'nestos-resource-')); closes.push(() => rm(root, {recursive: true, force: true}));
    const git = async (cwd: string, args: string[]) => exec('git', args, {cwd});
    await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fixture']); await git(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(root, '.gitignore'), '/_nestos/\n/cache/\n'); await writeFile(join(root, 'file.txt'), 'Original');
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'test: base']);
    const directory = '/workspace/_nestos/worktrees/ready', physical = join(root, '_nestos/worktrees/ready');
    await git(root, ['worktree', 'add', '-b', 'work/ready', physical]);
    const tree = {id: 'ready', directory, branch: 'work/ready', baseCommit: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), phase: 'ready' as const};
    const commands: string[][] = [];
    const process = {release: vi.fn(async () => {}), nativeShell: {exec: async (_name: string, args: string[], options: {cwd: string}) => {
        commands.push(args); const actual = args.map(value => value.replaceAll('/workspace', root));
        try {const r = await git(options.cwd.replace('/workspace', root), actual); return {code: 0, stdout: r.stdout.replaceAll(root, '/workspace'), stderr: r.stderr};}
        catch (error) {const r = error as {code: number; stdout: string; stderr: string}; return {code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};}
    }}} as never;
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: directory + '/_nestos/kanban/inbox', name: 'result.yaml', content: 'Retained evidence', recursive: true});
    const journal = new KanbanAutomationJournal(fs); await journal.open();
    await journal.update('worktree:ready', () => tree);
    await journal.update('development-workspace:ready', () => ({directory, projectId: 'project', context: {board: {id: 'board'}, task: {id: 'item'}}}));
    const item = {id: 'item', status: 'completed', revision: 1, externalRefs: [{system: 'nestos-remote-project', id: 'project'}, {system: 'nestos-worktree', id: 'ready'}]};
    const service = {item: async () => ({item}), read: async () => ({members: [{kind: 'human', id: 'admin', roles: ['coordinator']}]}),
        currentPrincipal: async () => ({kind: 'human', id: 'admin'}), workflow: async () => ({dispatches: {}})} as never;
    const workLog = {records: vi.fn(async () => ({items: []})), append: vi.fn(async () => {})};
    const mount = {at: '/', access: 'rw', connectionId: 'connection', serverProjectId: 'server-project', serverProjectRevision: 1, serverId: 'server'};
    const options = {fs, service, workLog, journal, calls: {}, kernel: {},
        projects: {get: async () => ({path: '/project', name: 'Project'}), openWorkspace: async () => ({fs, dispose: async () => {}})},
        remote: {list: () => [mount], resolveConnection: async () => ({})}, provider: {
            projects: () => ({read: async () => ({revision: 1, mounts: []}), close: async () => {}}),
            capabilities: async () => ({serverId: 'server', processEpoch: 'epoch'}), projectProcess: async () => process}} as never;
    return {root, physical, fs, tree, process, git, item, service, workLog, commands, api: developmentWorkResources(options)};
}
it('checks real Git ancestry, uncommitted changes and ignored files before offering cleanup', async () => {
    const f = await fixture(); expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toEqual([]);
    await writeFile(join(f.physical, 'file.txt'), 'Uncommitted');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toContain('WORKTREE_DIRTY');
    await f.git(f.physical, ['add', 'file.txt']); await f.git(f.physical, ['commit', '-m', 'test: unintegrated']);
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toContain('WORKTREE_NOT_INTEGRATED');
    await mkdir(join(f.physical, 'cache')); await writeFile(join(f.physical, 'cache/private'), 'Keep');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree))).toContain('WORKTREE_UNTRACKED_IGNORED');
});
it('lists saved associations without remote Git or native-session inspection and refuses unchecked cleanup', async () => {
    const f = await fixture(); f.commands.splice(0);
    const rows = await f.api.workResources('board','item',{inspect:false});
    expect(rows[0]).toMatchObject({id:'ready',title:'work/ready',location:f.tree.directory,state:'associated',canCleanup:false,version:''});
    expect(f.commands).toEqual([]); expect(native.reasons).toEqual([]);
    await expect(f.api.cleanupWorkResource('board',{operationId:'unchecked',itemId:'item',resourceId:'ready',version:''})).rejects.toMatchObject({code:'INVALID_WORK_RESOURCE_CLEANUP'});
    await expect(f.api.workResources('board','item',{inspect:'yes'} as never)).rejects.toMatchObject({code:'INVALID_WORK_RESOURCE_QUERY'});
});
it('excludes only archived protocol evidence without enumerating ignored dependency files', async () => {
    const f = await fixture();
    await mkdir(join(f.physical, '_nestos/kanban/inbox'), {recursive: true});
    await writeFile(join(f.physical, '_nestos/kanban/inbox/result.yaml'), 'Evidence');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree, '_nestos/kanban/'))).toEqual([]);
    await writeFile(join(f.physical, '_nestos/private'), 'Keep');
    expect(worktreeBlockers(await inspectWorktree(f.process, f.tree, '_nestos/kanban/'))).toContain('WORKTREE_UNTRACKED_IGNORED');
    expect(f.commands.some(args => args[0] === 'ls-files' && args.includes('--directory'))).toBe(true);
});
it('archives evidence before safe removal, deletes only the merged branch and returns the original receipt on retry', async () => {
    const f = await fixture(), preview = (await f.api.workResources('board', 'item'))[0];
    expect(preview).toMatchObject({id: 'ready', state: 'cleanup-ready', canCleanup: true});
    const request = {operationId: 'cleanup-one', itemId: 'item', resourceId: 'ready', version: preview.version};
    expect(await f.api.cleanupWorkResource('board', request)).toMatchObject({state: 'cleaned', canCleanup: false});
    expect(new TextDecoder().decode(await f.fs.driver.readContent('/var/lib/kanban/worktree-archives/ready/inbox/result.yaml', {encoding: 'binary'}))).toBe('Retained evidence');
    await expect(stat(f.physical)).rejects.toMatchObject({code: 'ENOENT'});
    expect(f.commands.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toEqual([['worktree', 'remove', f.tree.directory]]);
    await f.api.cleanupWorkResource('board', request);
    expect(f.commands.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(1);
    expect(f.commands.flat()).not.toContain('--force'); expect(f.commands.flat()).not.toContain('-D');
    expect(f.workLog.append).toHaveBeenCalledWith(expect.anything(), 'board', 'item', expect.objectContaining({stage: 'worktree.cleaned'}));
});
it('refuses unfinished tasks, changed previews and sessions that become busy before cleanup', async () => {
    const f = await fixture(), resource = (await f.api.workResources('board', 'item'))[0];
    const request = {operationId: 'cleanup-one', itemId: 'item', resourceId: 'ready', version: resource.version};
    f.item.revision++;
    await expect(f.api.cleanupWorkResource('board', request)).rejects.toMatchObject({code: 'WORKTREE_STATE_CHANGED'});
    f.item.revision--; f.item.status = 'claimed';
    await expect(f.api.cleanupWorkResource('board', request)).rejects.toMatchObject({code: 'WORKTREE_TASK_UNFINISHED'});
    f.item.status = 'completed'; native.reasons = ['WORKTREE_IN_USE'];
    await expect(f.api.cleanupWorkResource('board', request)).rejects.toMatchObject({code: 'WORKTREE_IN_USE'});
    expect(f.commands.some(args => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect((await stat(f.physical)).isDirectory()).toBe(true);
});
it('keeps the directory intact when evidence cannot be archived', async () => {
    const f = await fixture(), resource = (await f.api.workResources('board', 'item'))[0];
    const create = f.fs.driver.createFile.bind(f.fs.driver);
    vi.spyOn(f.fs.driver, 'createFile').mockImplementation(async options => {
        if (options.parentPath?.startsWith('/var/lib/kanban/worktree-archives/')) throw Object.assign(new Error('disk unavailable'), {code: 'EIO'});
        return create(options);
    });
    await expect(f.api.cleanupWorkResource('board', {operationId: 'archive-failure', itemId: 'item', resourceId: 'ready', version: resource.version})).rejects.toMatchObject({code: 'EIO'});
    expect((await stat(f.physical)).isDirectory()).toBe(true);
    expect(f.commands.some(args => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect((await f.api.workResources('board', 'item'))[0]).toMatchObject({state: 'cleanup-ready', canCleanup: true});
});
it('allows only one cleanup owner under concurrent requests', async () => {
    const f = await fixture(), resource = (await f.api.workResources('board', 'item'))[0];
    const request = {operationId: 'same-cleanup', itemId: 'item', resourceId: 'ready', version: resource.version};
    const result = await Promise.allSettled([f.api.cleanupWorkResource('board', request), f.api.cleanupWorkResource('board', request)]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(f.commands.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(1);
});
it('recovers a historical resource association from its original dispatch without inventing task ownership', async () => {
    const f = await fixture(); f.item.externalRefs = f.item.externalRefs.filter(row => row.system !== 'nestos-worktree');
    (f.service as any).workflow = async () => ({dispatches: {ready: {id: 'ready', itemId: 'item', outcome: 'accepted'}, other: {id: 'foreign', itemId: 'elsewhere', outcome: 'accepted'}}});
    expect(await f.api.workResources('board', 'item')).toEqual([expect.objectContaining({id: 'ready', state: 'cleanup-ready'})]);
});
it('serializes checks on the same node and never replays an unknown process admission', async () => {
    const f = await fixture(), shell = (f.process as any).nativeShell, original = shell.exec; let active = 0;
    shell.exec = vi.fn(async (...args: unknown[]) => {
        expect(active).toBe(0); active++;
        try {await new Promise(resolve => setTimeout(resolve, 2)); return await original(...args);}
        finally {active--;}
    });
    await Promise.all([f.api.workResources('board', 'item'), f.api.workResources('board', 'item')]);
    shell.exec = vi.fn(async () => {throw Object.assign(new Error('unknown'), {code: 'EIO', remoteCode: 'EBUSY', outcome: 'unknown'});});
    expect((await f.api.workResources('board', 'item'))[0]).toMatchObject({state: 'unknown', canCleanup: false});
    expect(shell.exec).toHaveBeenCalledOnce();
});
it('retries only a busy admission that the node confirms did not start', async () => {
    const f = await fixture(), shell = (f.process as any).nativeShell, original = shell.exec;
    shell.exec = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), {code: 'EIO', remoteCode: 'EBUSY', outcome: 'not-committed'})).mockImplementation(original);
    expect((await f.api.workResources('board', 'item'))[0]).toMatchObject({state: 'cleanup-ready'});
});
