import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {developmentReviewAdapter} from '../src/presets/kanban-development-review';
const mock = vi.hoisted(() => ({dirty: false, busy: false, context: true, process: {}}));
vi.mock('../src/presets/kanban-development-workspace', () => ({developmentWorkspace: async (_remote, _provider, _project, work) => work(mock.process)}));
vi.mock('../src/presets/kanban-work-resource-execution', () => ({workResourceExecution: async () => mock.busy ? ['OPERATION_ORIGINAL_SESSION_BUSY'] : []}));
vi.mock('../src/projects/worktree-status', () => ({inspectWorktree: async () => ({exists: true, head: 'source-head', targetHead: 'target-head', targetBranch: 'main'})}));
vi.mock('../src/projects/worktree-modules', () => ({gitWorkspace: async () => ({stdout: mock.dirty ? ' M file' : ''}), verifyWorktreeDelivery: async () => [{path: '.', fingerprint: 'delivery'}]}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: {original: {id: 'binding', branchId: 'main', connectionId: 'work-original', validity: mock.context ? 'valid' : 'invalid', revision: 7, generation: 2}}}})}));
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); mock.dirty = mock.busy = false; mock.context = true;});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const journal = new KanbanAutomationJournal(fs); await journal.open();
    await journal.update('worktree:original', () => ({id: 'original', directory: '/workspace/_nestos/worktrees/original', branch: 'work/original', phase: 'ready'}));
    await journal.update('development-workspace:original', () => ({directory: '/workspace/_nestos/worktrees/original', projectId: 'project', context: {board: {id: 'board'}, task: {id: 'task'}}, policy: {profile: 'development', commit: 'changes', modules: []}}));
    const item = {id: 'task', title: 'Task', responsibility: 'Work', acceptance: 'Verify', externalRefs: [{system: 'nestos-worktree', id: 'original'}, {system: 'nestos-remote-project', id: 'project'}]}, board = {id: 'board'};
    const target = {kind: 'agent', id: 'original-agent', version: '1', digest: 'original-digest'};
    const calls = {list: vi.fn(async () => [{receipt: {executionSessionId: 'original-session'}, callerState: {settled: true}, executionTree: {settled: true}, input: {request: {expectedTarget: target, expectedBranch: 'main', overrides: {connection: 'original-connection'}}}}])};
    const api = developmentReviewAdapter({fs, journal, calls, kernel: {sessionActivity: async () => ({counts: {}})}, projects: {get: async () => ({path: '/project'}), openWorkspace: async () => ({fs, dispose: async () => {}})}, runningVersion: 'running', service: {workflow: async () => ({dispatches: {}}), read: async () => board, item: async () => ({item})}} as never);
    return {api, journal, fs, item: item as never, board: board as never, target, calls};
}
it('prepares merge analysis in the original logical Session and exact native context without executing it', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareAnalysis({id: 'analysis', board: f.board, item: f.item, snapshot});
    expect(request).toMatchObject({expectedSessionId: 'original-session', expectedTarget: f.target, overrides: {branchMode: 'continue', harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 7, expectedGeneration: 2}}});
    expect(request.source).toMatchObject({kind: 'composer', text: expect.stringContaining('READ-ONLY')});
    expect(await f.journal.get('worktree:analysis')).toMatchObject({id: 'original'});
    const bundle = (await f.journal.get<{prompts: {files: Array<{name: string}>}}>('development-policy:analysis'))!;
    expect(bundle.prompts.files.map(row => row.name)).toContain('task-merge-pre.md'); expect(bundle.prompts.files.map(row => row.name)).toContain('task-merge-post.md');
    expect(await f.fs.driver.exists('/workspace/_nestos/worktrees/original/_nestos/kanban/review/analysis/manifest.json')).toBe(true);
    expect(f.calls.list).toHaveBeenCalledWith({sessionId: 'original'});
});
it('refuses a dirty target, busy original session and invalid native binding', async () => {
    const f = await fixture(); mock.dirty = true; await expect(f.api.snapshot(f.board, f.item)).rejects.toMatchObject({code: 'OPERATION_TARGET_DIRTY'});
    mock.dirty = false; const snapshot = await f.api.snapshot(f.board, f.item);
    mock.busy = true; await expect(f.api.prepareAnalysis({id: 'busy', board: f.board, item: f.item, snapshot})).rejects.toMatchObject({code: 'OPERATION_ORIGINAL_SESSION_BUSY'});
    mock.busy = false; mock.context = false; await expect(f.api.prepareAnalysis({id: 'invalid', board: f.board, item: f.item, snapshot})).rejects.toMatchObject({code: 'OPERATION_ORIGINAL_CONTEXT_UNAVAILABLE'});
    expect(await f.journal.get('worktree:busy')).toBeUndefined();
});
