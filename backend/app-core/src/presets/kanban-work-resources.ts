import {randomUUID, sha256HexSync, t, createModuleLogger} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import type {KanbanService, KanbanWorkResource, KanbanWorkResourceCleanup, KanbanExternalReference} from '@itookit/kanban/contracts';
import type {KanbanWorkLog} from '../kanban/work-log';
import {requireValue} from '../kanban/validation';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {workResourceExecution, type ResourceExecutionOptions} from './kanban-work-resource-execution';
import {inspectWorktree, worktreeBlockers} from '../projects/worktree-status';
import {gitWorkspace} from '../projects/worktree-modules';
import type {PreparedWorktree} from '../projects/worktree-preparation';
import {archiveWorktree} from './kanban-work-resource-archive';
import type {RemoteFileSourceProvider} from '../projects/remote-mounts';

const log = createModuleLogger('kanban-work-resources');
/** Display persisted associations without inspecting Git or contacting a node. */
export async function developmentSessionResources(journal: import('../kanban/automation-journal').KanbanAutomationJournal, executionId: string) {
    const id = executionId.replace(/-postload-(succeeded|failed|cancelled)$/, '');
    const tree = await journal.get<PreparedWorktree>('worktree:' + id);
    if (!tree) return [];
    return [{label: 'Worktree', value: tree.id}, {label: t('kanban.workResourceBranch'), value: tree.branch},
        {label: t('kanban.workResourceLocation'), value: tree.directory}];
}
interface Options extends ResourceExecutionOptions {
    fs: IFileSystem; provider: RemoteFileSourceProvider; service: KanbanService; workLog: KanbanWorkLog;
    projects: Pick<import('@itookit/app-contracts/services').ProjectService, 'get' | 'openWorkspace'>;
}
interface Cleanup {operationId: string; boardId: string; itemId: string; version: string; phase: 'prepared' | 'removing' | 'cleaned'; archive?: string}
interface ResourceScope {id: string; item: Awaited<ReturnType<KanbanService['item']>>['item']; record: DevelopmentWorkspaceRecord; tree: PreparedWorktree}

export function developmentWorkResources(options: Options) {
    return {workResources: async (boardId: string, itemId: string, query?: import('@itookit/kanban/contracts').KanbanWorkResourceQuery) => {
        const started = Date.now(), operationId = randomUUID(), stage = query?.inspect === false ? 'associations' : 'inspect';
        try {
            requireValue(query === undefined || !!query && typeof query === 'object' && !Array.isArray(query) && Object.keys(query).every(key => key === 'inspect')
                && (query.inspect === undefined || typeof query.inspect === 'boolean'), 'INVALID_WORK_RESOURCE_QUERY');
            const rows = await (query?.inspect === false ? associations(options, boardId, itemId) : list(options, boardId, itemId));
            log.debug('work-resource.list', {operation: 'work-resource.list', operationId, stage, result: 'success', count: rows.length, durationMs: Date.now() - started}); return rows;
        } catch (error) {
            log.warn('work-resource.list', {operation: 'work-resource.list', operationId, stage, result: 'failure', code: safeCode(error), durationMs: Date.now() - started}); throw error;
        }
    },
        cleanupWorkResource: (boardId: string, request: KanbanWorkResourceCleanup) => cleanup(options, boardId, structuredClone(request))};
}
async function associations(options: Options, boardId: string, itemId: string): Promise<KanbanWorkResource[]> {
    const refs = await references(options, boardId, itemId), rows: KanbanWorkResource[] = [];
    for (let offset = 0; offset < refs.length; offset += 8) rows.push(...await Promise.all(refs.slice(offset, offset + 8).map(async (ref): Promise<KanbanWorkResource> => {
        const [tree, cleanup] = await Promise.all([options.journal.get<PreparedWorktree>('worktree:' + ref.id), options.journal.get<Cleanup>('worktree-cleanup:' + ref.id)]);
        return {id: ref.id, kind: 'git-worktree', title: tree?.branch ?? ref.id, location: tree?.directory ?? ref.id, version: '',
            state: cleanup?.phase === 'cleaned' ? 'cleaned' : 'associated', reasons: [], canCleanup: false,
            properties: tree ? [{label: t('kanban.workResourceBranch'), value: tree.branch}] : []};
    })));
    return rows;
}
async function references(options: Options, boardId: string, itemId: string): Promise<KanbanExternalReference[]> {
    const {item} = await options.service.item(boardId, itemId), refs = [...item.externalRefs ?? []]; let cursor: string | undefined;
    const workflow = await options.service.workflow(boardId);
    for (const dispatch of Object.values(workflow.dispatches)) if (dispatch.itemId === itemId) {
        const tree = await options.journal.get<PreparedWorktree>('worktree:' + dispatch.id);
        if (tree) refs.push({system: 'nestos-worktree', id: tree.id ?? dispatch.id});
    }
    do {
        const page = await options.workLog.records(options.service, boardId, {itemId, kind: 'log', limit: 200, ...(cursor ? {cursor} : {})});
        refs.push(...page.items.flatMap(row => row.externalRefs ?? [])); cursor = page.nextCursor;
        requireValue(refs.length <= 10000, 'WORK_RESOURCE_LIMIT');
    } while (cursor);
    return [...new Map(refs.filter(ref => ref.system === 'nestos-worktree').map(ref => [ref.id, ref])).values()];
}
async function scope(options: Options, boardId: string, itemId: string, id: string, known?: KanbanExternalReference[]): Promise<ResourceScope> {
    requireValue(/^[\w-]{1,128}$/.test(id), 'WORKTREE_SCOPE_INVALID');
    const {item} = await options.service.item(boardId, itemId);
    requireValue((known ?? await references(options, boardId, itemId)).some(ref => ref.id === id), 'WORKTREE_NOT_ASSOCIATED');
    const record = await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + id);
    const tree = await options.journal.get<PreparedWorktree>('worktree:' + id);
    requireValue(record && tree && tree.directory === record.directory, 'WORKTREE_ASSOCIATION_UNKNOWN');
    requireValue(tree.directory === '/workspace/_nestos/worktrees/' + id && tree.branch === 'work/' + id, 'WORKTREE_SCOPE_INVALID');
    requireValue(item.externalRefs?.some(ref => ref.system === 'nestos-remote-project' && ref.id === record.projectId), 'WORKTREE_PROJECT_CHANGED');
    return {id, item, record, tree};
}
async function list(options: Options, boardId: string, itemId: string): Promise<KanbanWorkResource[]> {
    const refs = await references(options, boardId, itemId), rows: KanbanWorkResource[] = [];
    for (let offset = 0; offset < refs.length; offset += 4) {
        const batch = await Promise.allSettled(refs.slice(offset, offset + 4).map(ref => inspectReference(options, boardId, itemId, ref, refs)));
        for (const row of batch) {if (row.status === 'rejected') throw row.reason; rows.push(row.value);}
    }
    return rows;
}
async function inspectReference(options: Options, boardId: string, itemId: string, ref: KanbanExternalReference, refs: KanbanExternalReference[]): Promise<KanbanWorkResource> {
    const started = Date.now();
    try {return await inspect(options, boardId, await scope(options, boardId, itemId, ref.id, refs));}
    catch (error) {
        log.warn('work-resource.inspect', {operation: 'work-resource.inspect', operationId: randomUUID(), stage: 'inspect',
            result: 'failure', code: safeCode(error), resourceId: /^[\w-]{1,128}$/.test(ref.id) ? ref.id : undefined, durationMs: Date.now() - started});
        const tree = /^[\w-]{1,128}$/.test(ref.id) ? await options.journal.get<PreparedWorktree>('worktree:' + ref.id) : undefined;
        return {id: ref.id, kind: 'git-worktree', title: 'Git worktree', location: tree?.directory ?? ref.id, version: '',
            state: 'unknown', canCleanup: false, reasons: [safeCode(error)], properties: tree ? [{label: t('kanban.workResourceBranch'), value: tree.branch}] : []};
    }
}
async function inspect(options: Options, boardId: string, resource: ResourceScope): Promise<KanbanWorkResource> {
    const {id, item, record, tree} = resource, saved = await options.journal.get<Cleanup>('worktree-cleanup:' + id);
    const base = {id, kind: 'git-worktree', title: 'Git worktree', location: record.directory,
        properties: [{label: t('kanban.workResourceBranch'), value: tree.branch}, {label: t('kanban.workResourceProject'), value: (await options.projects.get(record.projectId)).name}]};
    if (saved) return {...base, properties: [...base.properties, ...(saved.archive ? [{label: t('kanban.workResourceArchive'), value: saved.archive}] : [])], version: saved.version, state: saved.phase === 'cleaned' ? 'cleaned' : 'unknown', canCleanup: false,
        reasons: saved.phase === 'cleaned' ? [] : ['WORKTREE_CLEANUP_UNCONFIRMED']};
    const state = await developmentWorkspace(options.remote, options.provider, record.projectId, process => inspectWorktree(process, tree, '_nestos/kanban/'));
    const reasons = worktreeBlockers(state), context = record.context as {board?: {id?: string}; task?: {id?: string}} | undefined;
    if (context?.board?.id !== boardId || context?.task?.id !== item.id) reasons.push('WORKTREE_ASSOCIATION_UNVERIFIED');
    if (item.status !== 'completed') reasons.push('WORKTREE_TASK_UNFINISHED');
    const dispatch = (await options.service.workflow(boardId)).dispatches[id];
    if (dispatch && ['prepared', 'running', 'unknown', 'succeeded'].includes(dispatch.outcome)) reasons.push('WORKTREE_IN_USE');
    if (!reasons.length) reasons.push(...await workResourceExecution(options, id, record.projectId));
    const version = sha256HexSync(JSON.stringify([state.version, item.revision, item.status, reasons]));
    return {...base, version, reasons, state: reasons.includes('WORKTREE_IN_USE') ? 'in-use' : reasons.length ? 'retained' : 'cleanup-ready',
        canCleanup: reasons.length === 0, properties: [...base.properties, {label: t('kanban.workResourceTarget'), value: state.targetBranch},
            ...(state.head ? [{label: 'HEAD', value: state.head.slice(0, 12)}] : [])]};
}
async function cleanup(options: Options, boardId: string, request: KanbanWorkResourceCleanup): Promise<KanbanWorkResource> {
    const started = Date.now(), owner = randomUUID(), operationId = /^[\w-]{1,128}$/.test(request.operationId) ? request.operationId : owner; let stage = 'authorize', claimed = false;
    try {
        requireValue(/^[\w-]{1,128}$/.test(request.operationId) && /^[a-f0-9]{64}$/.test(request.version), 'INVALID_WORK_RESOURCE_CLEANUP');
        const board = await options.service.read(boardId), actor = await options.service.currentPrincipal();
        requireValue(board.members?.some(row => row.kind === actor.kind && row.id === actor.id && row.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
        const resource = await scope(options, boardId, request.itemId, request.resourceId), key = 'worktree-cleanup:' + resource.id;
        const old = await options.journal.get<Cleanup>(key);
        if (old) {requireValue(old.operationId === request.operationId && old.version === request.version && old.boardId === boardId && old.itemId === request.itemId, 'WORKTREE_CLEANUP_CONFLICT');
            requireValue(old.phase === 'cleaned', 'WORKTREE_CLEANUP_UNCONFIRMED'); await reportCleanup(options, boardId, resource, request.operationId); return inspect(options, boardId, resource);}
        stage = 'validate'; const current = await inspect(options, boardId, resource);
        requireValue(current.canCleanup, current.reasons[0] ?? 'WORKTREE_CLEANUP_BLOCKED');
        requireValue(current.version === request.version, 'WORKTREE_STATE_CHANGED');
        const claim = await options.journal.update<Cleanup & {owner?: string}>(key, saved => saved ?? {
            operationId: request.operationId, boardId, itemId: request.itemId, version: request.version, phase: 'prepared', owner});
        requireValue(claim.owner === owner, 'WORKTREE_CLEANUP_UNCONFIRMED');
        claimed = true;
        stage = 'archive-and-remove'; await remove(options, resource, key, boardId, request.version);
        await reportCleanup(options, boardId, resource, request.operationId);
        return inspect(options, boardId, resource);
    } catch (error) {
        if (claimed) await options.journal.update<(Cleanup & {owner?: string}) | null>('worktree-cleanup:' + request.resourceId,
            old => old?.owner === owner && old.phase === 'prepared' ? null : old ?? null).catch(releaseError => {
                log.warn('work-resource.cleanup', {operation: 'work-resource.cleanup', operationId, stage: 'claim-release', result: 'failure', code: safeCode(releaseError), durationMs: Date.now() - started});
            });
        log.warn('work-resource.cleanup', {operation: 'work-resource.cleanup', operationId, stage,
        result: 'failure', code: safeCode(error), durationMs: Date.now() - started}); throw error;}
    finally {log.debug('work-resource.cleanup.finished', {operation: 'work-resource.cleanup', operationId, stage, durationMs: Date.now() - started});}
}
async function reportCleanup(options: Options, boardId: string, resource: ResourceScope, operationId: string): Promise<void> {
    await options.workLog.append(options.service, boardId, resource.item.id, {stage: 'worktree.cleaned', result: 'success', dispatchId: resource.id,
        fields: {operationId}, references: [{system: 'nestos-worktree', id: resource.id}]});
}
async function remove(options: Options, resource: ResourceScope, key: string, boardId: string, version: string): Promise<void> {
    const {id, record, tree} = resource, folder = await options.projects.get(record.projectId), view = await options.projects.openWorkspace(folder.path);
    try {
        const archive = await archiveWorktree(view.fs, options.fs, record.directory, id);
        await options.journal.update<Cleanup>(key, old => ({...old!, archive}));
        await developmentWorkspace(options.remote, options.provider, record.projectId, async process => {
            const state = await inspectWorktree(process, tree, '_nestos/kanban/');
            requireValue(!worktreeBlockers(state).length, worktreeBlockers(state)[0] ?? 'WORKTREE_STATE_CHANGED');
            const latest = (await options.service.item(boardId, resource.item.id)).item;
            requireValue(latest.status === 'completed' && sha256HexSync(JSON.stringify([state.version, latest.revision, latest.status, []])) === version, 'WORKTREE_STATE_CHANGED');
            requireValue(!(await workResourceExecution(options, id, record.projectId)).length, 'WORKTREE_IN_USE');
            await archiveWorktree(view.fs, options.fs, record.directory, id);
            await options.journal.update<Cleanup>(key, old => ({...old!, phase: 'removing'}));
            await gitWorkspace(process, '/workspace', ['worktree', 'remove', tree.directory]);
            await gitWorkspace(process, '/workspace', ['branch', '-d', tree.branch]);
            await options.journal.update<Cleanup>(key, old => ({...old!, phase: 'cleaned'}));
        });
    } finally {await view.dispose();}
}
function safeCode(error: unknown): string {
    const value = error as {code?: unknown; remoteCode?: unknown}, code = value?.remoteCode ?? value?.code;
    if (code === 'EBUSY') return 'WORK_RESOURCE_NODE_BUSY';
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'WORK_RESOURCE_CHECK_FAILED';
}
