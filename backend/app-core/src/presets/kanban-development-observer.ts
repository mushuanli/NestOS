import {readContextCatalog, type ContextInspector} from '../projects/harness-context-catalog';
import type {PreparedWorktree} from '../projects/worktree-preparation';
import {journalCommand} from '../kanban/journal-command';
import type {IFileSystem} from '@itookit/vfs-core';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {KanbanCommand} from '@itookit/kanban/contracts';
import {consumeWorkspaceMessages, type WorkspaceMessage} from '../run/workspace-messages';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/record-execution';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {UserEventService} from '../events/service';

type Input = Parameters<NonNullable<PersonalKanbanAutomationOptions['observeWork']>>[0];
interface Options {kernel: ContextInspector; fs: IFileSystem; events: UserEventService; projects: Pick<ProjectService, 'get' | 'openWorkspace'>;
    remote?: Pick<import('../projects/remote-mounts').ProjectRemoteMountService, 'projectHarness'>; wake(): void}

export function developmentObserver(options: Options) {
    const journal = new KanbanAutomationJournal(options.fs);
    const watches = new Map<string, () => Promise<void>>(); let stopped = false;
    const observe: NonNullable<PersonalKanbanAutomationOptions['observeWork']> = async input => {
        if (stopped) return input.observation;
        const worktree = await journal.get<PreparedWorktree>('worktree:' + input.dispatch.id);
        if (!worktree) return input.observation;
        const {item} = await input.service.item(input.boardId, input.dispatch.itemId);
        const projectId = item.externalRefs?.find(ref => ref.system === REMOTE_PROJECT_REFERENCE)?.id;
        if (!projectId) throw Object.assign(new Error('Missing workspace project binding'), {code: 'WORKSPACE_PROJECT_MISSING'});
        if (options.remote && !watches.has(input.dispatch.id)) {
            const client = await options.remote.projectHarness(projectId);
            if (stopped) {await client.close(); return input.observation;}
            const stop = client.subscribeDirectoryPath?.('_nestos/worktrees/' + input.dispatch.id + '/_nestos/kanban/inbox', options.wake);
            watches.set(input.dispatch.id, async () => {stop?.(); await client.close();});
        }
        await linkReference(journal, input, {system: 'nestos-worktree', id: input.dispatch.id,
            revision: JSON.stringify({projectId, directory: worktree.directory, branch: worktree.branch, baseCommit: worktree.baseCommit})});
        await linkResult(options, journal, input, projectId);
        const folder = await options.projects.get(projectId), view = await options.projects.openWorkspace(folder.path);
        try {
            const scope = {runId: item.externalRefs?.find(ref => ref.system === 'nestos-decision-run')?.id ?? input.dispatch.planId,
                itemId: item.id, attemptId: input.dispatch.id};
            const messages = await consumeWorkspaceMessages(view.fs, '/workspace/_nestos/worktrees/' + input.dispatch.id + '/_nestos/kanban', scope, journal,
                message => deliver(options, journal, input, message));
            if (['failed', 'cancelled'].includes(input.observation.outcome)) await close(input.dispatch.id);
            if (input.observation.outcome !== 'succeeded') return input.observation;
            if (messages.some(message => ['clarification', 'error'].includes(message.type))) return {...input.observation, outcome: 'running', outputs: undefined, code: 'WORKSPACE_INPUT_REQUIRED'};
            if (!messages.some(message => message.type === 'result')) return {...input.observation, outcome: 'unknown', outputs: undefined, code: 'WORKSPACE_RESULT_MISSING'};
            await close(input.dispatch.id); return input.observation;
        } finally {await view.dispose();}
    };
    async function close(id: string) {const release = watches.get(id); watches.delete(id); await release?.();}
    return {observe, async dispose() {stopped = true; await Promise.allSettled([...watches.keys()].map(close));}};
}

async function linkResult(options: Options, journal: KanbanAutomationJournal, input: Input, projectId: string): Promise<void> {
    const sessionId = input.observation.executionSessionId;
    if (!sessionId) return;
    const catalog = await readContextCatalog(options.kernel, sessionId);
    const binding = Object.values(catalog.value.bindings).find(binding => binding.connectionId === 'work-' + input.dispatch.id);
    if (!binding?.nativeRef?.sessionId) return;
    await linkReference(journal, input, {system: 'nestos-native-session', id: binding.nativeRef.sessionId,
        revision: JSON.stringify({projectId, connectionId: binding.connectionId, profileId: binding.nativeRef.profileId,
            turnId: binding.knownHeadRef, dispatchId: input.dispatch.id})});
}
async function linkReference(journal: KanbanAutomationJournal, input: Input, reference: import('@itookit/kanban/contracts').KanbanExternalReference): Promise<void> {
    const {item} = await input.service.item(input.boardId, input.dispatch.itemId);
    if (item.externalRefs?.some(ref => JSON.stringify(ref) === JSON.stringify(reference))) return;
    const key = 'workspace-reference:' + input.dispatch.id + ':' + reference.system + ':' + (reference.revision ?? '');
    await journalCommand(journal, input.service, input.boardId, key, {type: 'link-reference', itemId: item.id, reference});
}

async function deliver(options: Options, journal: KanbanAutomationJournal, input: Input, message: WorkspaceMessage): Promise<void> {
    await once(journal, input, message.id + ':log', {type: 'message', itemId: message.itemId, message: message.content, recipientSessionIds: []});
    if (!['clarification', 'error'].includes(message.type)) return;
    await once(journal, input, message.id + ':block', {type: 'block-item', itemId: message.itemId, token: input.dispatch.fence,
        reason: message.type === 'clarification' ? 'WORKSPACE_INPUT_REQUIRED' : 'WORKSPACE_ERROR_REPORTED'});
    await options.events.journal.transaction(async tx => {
        const key = 'work-message:' + message.attemptId + ':' + message.id;
        if (await tx.getState(key)) return;
        await tx.append(key, {type: 'kanban.workspace.' + message.type, operationId: message.attemptId,
            resourceId: 'kanban:' + JSON.stringify(['personal:user-store', input.boardId, message.itemId]), notification: message.type === 'error' ? 'error' : 'info'}, Date.now());
        await tx.setState(key, 'delivered');
    });
}
async function once(journal: KanbanAutomationJournal, input: Input, suffix: string, command: KanbanCommand): Promise<void> {
    const key = 'workspace-command:' + input.dispatch.id + ':' + suffix;
    await journalCommand(journal, input.worker, input.boardId, key, command);
}
