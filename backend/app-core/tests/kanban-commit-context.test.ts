import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {freezeCommitContext, verifyCommitContexts, parseCommitTrailers} from '../src/presets/kanban-commit-context';
import {resolveCommitRequest, preloadCommitContexts} from '../src/presets/kanban-commit-query';
const closes: Array<() => Promise<void>> = [], exec = promisify(execFile);
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'nestos-commit-context-')); closes.push(() => rm(root, {recursive: true, force: true}));
    const git = async (cwd: string, args: string[]) => (await exec('git', args, {cwd})).stdout.trim();
    await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fixture']); await git(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(root, '.gitignore'), '/_nestos/\n'); await writeFile(join(root, 'file'), 'Base'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'test: base']);
    const base = await git(root, ['rev-parse', 'HEAD']), physical = join(root, '_nestos/worktrees/task'); await git(root, ['worktree', 'add', '-b', 'work/task', physical]);
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/'); const journal = new KanbanAutomationJournal(fs); await journal.open();
    const source = {projectId: 'project', boardId: 'board', itemId: 'task', itemRevision: 2, executionId: 'execution', context: {board: {id: 'board'}, task: {id: 'task', revision: 2, acceptance: 'Original criterion'}, decision: {sourceBoardId: 'board', recordId: 'decision', snapshot: {revision: 1, content: 'Original decision'}}}};
    const context = await freezeCommitContext(journal, source);
    await writeFile(join(physical, 'file'), 'Delivery'); await git(physical, ['add', 'file']); await git(physical, ['commit', '-m', 'feat(test): delivery', '-m', context.trailers]);
    const head = await git(physical, ['rev-parse', 'HEAD']);
    const commands: string[][] = [];
    const process = {nativeShell: {exec: async (_name: string, args: string[], options: {cwd: string}) => {
        commands.push(args); try {const result = await exec('git', args, {cwd: options.cwd.replace('/workspace', root)}); return {code: 0, stdout: result.stdout, stderr: result.stderr};}
        catch (error) {const value = error as {code: number; stdout: string; stderr: string}; return {code: value.code, stdout: value.stdout ?? '', stderr: value.stderr ?? ''};}
    }}} as never;
    const repositories = [{path: '.', branch: 'work/task', baseCommit: base}], evidence = [{...repositories[0], head, dirty: false, changesDigest: 'unchanged'}];
    const record = {projectId: 'project', directory: '/workspace/_nestos/worktrees/task', repositories, availableRepositories: [], commitContext: context};
    const service = {item: vi.fn(async () => ({item: {id: 'task', revision: 3, status: 'completed', title: 'Task', responsibility: 'Work', acceptance: 'Current criterion'}})), record: vi.fn(async () => ({id: 'decision', revision: 2, content: 'Updated decision'}))};
    const options = {journal, process, record, service} as never;
    const request = {schema: 'work-message/2', id: 'request', type: 'request', scopeId: 'exchange', method: 'kanban.context.resolve', waitForResponse: true, params: {repository: '.', commits: [head], include: ['task', 'decisions', 'acceptance']}} as const;
    return {root, physical, git, fs, journal, source, context, base, head, process, record, service, evidence, options, request, commands};
}
it('freezes task/decision revisions, preserves the first context and repairs a missing digest index', async () => {
    const f = await fixture(); expect(f.context.trailers).toContain('NestOS-Task: task'); expect(parseCommitTrailers(f.context.trailers)['NestOS-Context']).toBe('sha256:' + f.context.digest);
    await f.fs.meta.seq!.deleteEntry('/var/lib/kanban/automation.seq', 'commit-context:' + f.context.digest);
    expect(await freezeCommitContext(f.journal, {...f.source, itemRevision: 99, context: {changed: true}})).toEqual(f.context);
    expect(await f.journal.get('commit-context:' + f.context.digest)).toEqual(f.context);
});
it('verifies actual Git trailers and rejects an unassociated commit without rewriting it', async () => {
    const f = await fixture(); expect(await verifyCommitContexts(f.process, f.record.directory, f.evidence, f.context)).toEqual([{repository: '.', commits: [f.head]}]);
    await writeFile(join(f.physical, 'file'), 'Changed again'); await f.git(f.physical, ['add', 'file']); await f.git(f.physical, ['commit', '-m', 'fix(test): missing identity']);
    const next = await f.git(f.physical, ['rev-parse', 'HEAD']);
    await expect(verifyCommitContexts(f.process, f.record.directory, [{...f.evidence[0], head: next}], f.context)).rejects.toMatchObject({code: 'COMMIT_TASK_CONTEXT_MISMATCH'});
    expect(await f.git(f.physical, ['rev-parse', 'HEAD'])).toBe(next);
});
it('preloads related contexts and distinguishes the original decision from current revisions', async () => {
    const f = await fixture(), result = await resolveCommitRequest(f.options, f.request as never) as {contexts: Array<{historical: unknown; current: unknown}>};
    expect(result.contexts).toHaveLength(1); expect(result.contexts[0]).toMatchObject({historical: {task: {revision: 2, acceptance: 'Original criterion'}, decision: {snapshot: {content: 'Original decision'}}}, current: {task: {revision: 3, acceptance: 'Current criterion'}, decision: {revision: 2, content: 'Updated decision'}}});
    expect(await preloadCommitContexts(f.options)).toMatchObject({contexts: [expect.objectContaining({commit: f.head})], unresolved: []});
});
it('refuses invalid repositories, malformed hashes and unreachable commits before consulting task data', async () => {
    const f = await fixture(); f.service.item.mockClear();
    await expect(resolveCommitRequest(f.options, {...f.request, params: {...f.request.params, repository: '..'}} as never)).rejects.toMatchObject({code: 'COMMIT_QUERY_REPOSITORY_FORBIDDEN', fileResponse: true});
    await expect(resolveCommitRequest(f.options, {...f.request, params: {...f.request.params, commits: ['--all']}} as never)).rejects.toMatchObject({code: 'COMMIT_QUERY_INVALID', fileResponse: true});
    const tree = await f.git(f.root, ['rev-parse', 'HEAD^{tree}']), outside = await f.git(f.root, ['commit-tree', tree, '-p', f.base, '-m', 'test: unreachable', '-m', f.context.trailers]);
    expect(await resolveCommitRequest(f.options, {...f.request, params: {...f.request.params, commits: [outside]}} as never)).toMatchObject({contexts: [], unresolved: [{commit: outside, code: 'COMMIT_NOT_REACHABLE'}]});
    expect(f.service.item).not.toHaveBeenCalled();
});
it('does not trust foreign scope trailers and reports legacy commits without inventing a task', async () => {
    const f = await fixture(); await f.journal.update('kanban-context-scope', () => 'other-owner'); f.service.item.mockClear();
    expect(await resolveCommitRequest(f.options, f.request as never)).toMatchObject({contexts: [], unresolved: [{code: 'COMMIT_CONTEXT_UNAVAILABLE'}]});
    expect(await resolveCommitRequest(f.options, {...f.request, params: {...f.request.params, commits: [f.base]}} as never)).toMatchObject({contexts: [], unresolved: [{code: 'COMMIT_CONTEXT_UNAVAILABLE'}]});
    expect(f.service.item).not.toHaveBeenCalled();
});
it('rejects modified stored context before returning any task or decision data', async () => {
    const f = await fixture(); await f.journal.update('commit-context:' + f.context.digest, () => ({...f.context, input: {forged: true}})); f.service.item.mockClear();
    await expect(resolveCommitRequest(f.options, f.request as never)).rejects.toMatchObject({code: 'COMMIT_CONTEXT_INTEGRITY_INVALID'});
    expect(f.service.item).not.toHaveBeenCalled();
});
it('respects the requested fields and avoids reading decisions for a task-only query', async () => {
    const f = await fixture();
    const result = await resolveCommitRequest(f.options, {...f.request, params: {...f.request.params, include: ['task']}} as never) as {contexts: Array<{historical: Record<string, unknown>; current: Record<string, unknown>}>};
    expect(result.contexts[0].historical).not.toHaveProperty('decision'); expect(result.contexts[0].historical.task).not.toHaveProperty('acceptance');
    expect(result.contexts[0].current).not.toHaveProperty('decision'); expect(f.service.record).not.toHaveBeenCalled();
});
