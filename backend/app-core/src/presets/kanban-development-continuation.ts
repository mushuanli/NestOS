import type {IFileSystem} from '@itookit/vfs-core';
import type {ContinueWorkOptions} from '../kanban/continued-work';
import type {ResourceExecutionOptions} from './kanban-work-resource-execution';
import {workResourceExecution} from './kanban-work-resource-execution';
import type {RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {PreparedWorktree} from '../projects/worktree-preparation';
import {inspectWorktree} from '../projects/worktree-status';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentPolicy} from './kanban-development-policy';
import {initializeDevelopmentExchange} from './kanban-file-exchange-protocol';
import {publishImmutableFile} from '../run/prompt-bundle';
import {initializeWorkspaceMessages} from '../run/workspace-messages';
import {publishPromptBundle} from '../run/prompt-bundle';
import {requireValue} from '../kanban/validation';

interface Options extends ResourceExecutionOptions {fs: IFileSystem; provider: RemoteFileSourceProvider;
    projects: Pick<ProjectService, 'get' | 'openWorkspace'>}
/** Reuse the original repository and communication history; publish a separate immutable mailbox. */
export function developmentContinuation(options: Options): NonNullable<ContinueWorkOptions['prepare']> {
    return async input => {
        const journal = options.journal, id = input.originalDispatch.id;
        const original = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + id);
        const tree = await journal.get<PreparedWorktree>('worktree:' + id);
        requireValue(original && tree && !await journal.get('worktree-cleanup:' + id), 'CONTINUATION_WORKSPACE_UNAVAILABLE');
        requireValue(input.item.externalRefs?.some(ref => ref.system === 'nestos-remote-project' && ref.id === original.projectId), 'WORKTREE_PROJECT_CHANGED');
        const reasons = await workResourceExecution(options, id, original.projectId);
        requireValue(!reasons.length, reasons[0] ?? 'CONTINUATION_IN_USE');
        await developmentWorkspace(options.remote, options.provider, original.projectId, async process => {
            requireValue((await inspectWorktree(process, tree, '_nestos/kanban/')).exists, 'WORKTREE_MISSING');
        });
        const folder = await options.projects.get(original.projectId), view = await options.projects.openWorkspace(folder.path);
        try {
            const record = await publishContinuation(options, input, original, tree, view.fs);
            const path = record.communicationDirectory!.replace('/workspace/', '') + '/';
            return `Continue the unfinished original task in this SAME Session and worktree. Preserve existing changes. The host explicitly admitted continuation ${input.dispatch.id}. `
                + `For this continuation, read ${path}manifest.json, protocol.json, prompts/task.md and prompts/task-continue-pre.md. `
                + `For additional context read ${path}exchange.json, publish an immutable work-message/2 request, then yield without a result; the host resumes this SAME Session after a response. Use ONLY ${path}inbox/ for new messages, with this continuation's attemptId from its protocol. Older mailbox events are historical evidence. `
                + `The original frozen commit policy remains ${record.policy.commit}. Do not rerun planning, recreate the worktree, merge, push or discard work. `
                + (input.dispatch.continuation?.instruction ?? 'Inspect retained work, finish the original acceptance criteria and publish verifiable results.');
        } finally {await view.dispose();}
    };
}
async function publishContinuation(options: Options, input: Parameters<NonNullable<ContinueWorkOptions['prepare']>>[0], original: DevelopmentWorkspaceRecord,
    tree: PreparedWorktree, fs: IFileSystem): Promise<DevelopmentWorkspaceRecord> {
    const {dispatch, item} = input, journal = options.journal;
    const policy = await developmentPolicy(journal, options.fs, fs, dispatch.id,
        {profile: original.policy.profile, commit: original.policy.commit, modules: original.policy.modules.join(',')});
    const record = await journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + dispatch.id, old => old ?? {...original, exchangeVersion: 2, policy,
        worktreeId: tree.id, communicationDirectory: original.directory + '/_nestos/kanban/continuations/' + dispatch.id,
        context: {...original.context as object, task: {id: item.id, parentId: item.planning?.parentId ?? null, title: item.title,
            responsibility: item.responsibility, acceptance: item.acceptance, dependencies: item.planning?.dependencies ?? []},
            continuation: {dispatchId: dispatch.id, previousDispatchId: dispatch.continuation!.previousDispatchId,
            originalDispatchId: input.originalDispatch.id, sessionId: input.sessionId}}});
    await journal.update('worktree:' + dispatch.id, old => old ?? tree);
    const managed = await journal.get('managed-agent:work-' + input.originalDispatch.id);
    requireValue(managed, 'CONTINUATION_TARGET_UNKNOWN');
    await journal.update('managed-agent:work-' + dispatch.id, old => old ?? managed);
    const scope = {runId: item.externalRefs?.find(ref => ref.system === 'nestos-decision-run')?.id ?? dispatch.planId, itemId: item.id, attemptId: dispatch.id};
    await initializeWorkspaceMessages(fs, record.communicationDirectory!, scope);
    await initializeDevelopmentExchange(fs, record.communicationDirectory!, dispatch.id);
    if (record.commitContext) await publishImmutableFile(fs, record.communicationDirectory!, 'commit-trailers.txt', record.commitContext.trailers);
    await publishPromptBundle(fs, record.communicationDirectory!, record.policy.prompts, {...scope, entry: 'prompts/task.md', commit: policy.commit,
        repositories: record.repositories, availableRepositories: record.availableRepositories, input: record.context});
    return record;
}
