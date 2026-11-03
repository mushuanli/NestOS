import {journalCommand} from '../kanban/journal-command';
import {DirectorySubscriptions} from '../run/directory-subscriptions';
import {initializeDevelopmentExchange} from './kanban-file-exchange-protocol';
import {preloadCommitContexts} from './kanban-commit-query';
import {developmentFileExchange} from './kanban-file-exchange';
import type {sessionSubmission} from '../run/session-submission';
import {t, sha256HexSync} from '@itookit/common';
import type {KanbanBoard, KanbanItem, KanbanService} from '@itookit/kanban/contracts';
import type {IndependentCallService} from '@itookit/llm-session';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import type {Kernel} from '@itookit/durable-kernel';
import type {IFileSystem} from '@itookit/vfs-core';
import type {ReviewAdapter, ReviewSnapshot, ReviewJob} from '../kanban/item-operation-types';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {requireValue} from '../kanban/validation';
import {readContextCatalog} from '../projects/harness-context-catalog';
import {inspectWorktree} from '../projects/worktree-status';
import {verifyWorktreeDelivery, gitWorkspace} from '../projects/worktree-modules';
import type {PreparedWorktree} from '../projects/worktree-preparation';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentWorkspace} from './kanban-development-workspace';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {developmentPolicy} from './kanban-development-policy';
import {publishPromptBundle} from '../run/prompt-bundle';
import {publishImmutableFile} from '../run/prompt-bundle';
import {readSessionFileResult, sessionFileResultPrompt} from '../run/session-file-result';
import {workResourceExecution} from './kanban-work-resource-execution';

interface Options {
    submission?: ReturnType<typeof sessionSubmission>; wake?(): void;
    fs: IFileSystem; journal: KanbanAutomationJournal; service: KanbanService; calls: Pick<IndependentCallService, 'list'>;
    kernel: Pick<Kernel, 'sessionActivity' | 'inspectSession'>; remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    projects: Pick<ProjectService, 'get' | 'openWorkspace'>; runningVersion?: string;
}
interface ReviewResource {id: string; tree: PreparedWorktree; record: DevelopmentWorkspaceRecord}
export function developmentReviewAdapter(options: Options): ReviewAdapter {
    const watches = new DirectorySubscriptions();
    const watch = async (job: ReviewJob) => {
        const record = await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + job.id);
        requireValue(record?.communicationDirectory, 'OPERATION_WORKSPACE_UNAVAILABLE');
        if (record.exchangeVersion !== 2) return record;
        await watches.ensure(job.id, async () => {const client = await options.remote.projectHarness(record.projectId);
            const stop = client.subscribeDirectoryPath?.(record.communicationDirectory!.replace('/workspace/', '') + '/inbox', () => options.wake?.());
            return async () => {stop?.(); await client.close();};});
        return record;
    };
    return {runningVersion: () => options.runningVersion, supports: (_board, item) => !!item.externalRefs?.some(ref => ref.system === 'nestos-worktree'),
        snapshot: (board, item) => snapshot(options, board, item), close: () => watches.dispose(),
        prepareAnalysis: input => prepareAnalysis(options, input),
        exchange: options.submission ? async (job, observation) => {
            const record = await watch(job);
            return developmentFileExchange({...options, submission: options.submission!}, {id: job.id, record, service: options.service,
                base: job.request!, observation, resultFile: 'analysis.yaml', targetHead: job.snapshot.targetVersion,
                beforeResume: async () => {requireValue((await snapshot(options, await options.service.read(job.boardId), (await options.service.item(job.boardId, job.itemId)).item)).version === job.snapshot.version, 'MERGE_PLAN_SOURCE_CHANGED');},
                report: (stage, id, code) => journalCommand(options.journal, options.service, job.boardId, 'review-context-log:' + job.id + ':' + stage + ':' + id,
                    {type: 'message', itemId: job.itemId, message: t(('kanban.fileExchange.' + stage) as Parameters<typeof t>[0]) + (code ? ': ' + code : ''), recipientSessionIds: []})});
        } : undefined,
        readAnalysis: async job => {const value = await readAnalysis(options, job); if (value !== undefined) await watches.close(job.id); return value;}};
}
async function resource(options: Options, item: KanbanItem, boardId: string): Promise<ReviewResource> {
    const refs = item.externalRefs?.filter(row => row.system === 'nestos-worktree') ?? [];
    const dispatch = Object.values((await options.service.workflow(boardId)).dispatches).filter(row => row.itemId === item.id).sort((a, b) => b.attempt - a.attempt)[0];
    const primary = dispatch ? await options.journal.get<PreparedWorktree>('worktree:' + dispatch.id) : undefined;
    const ref = primary ? refs.find(row => row.id === primary.id) : refs.length === 1 ? refs[0] : undefined;
    requireValue(ref, 'OPERATION_WORKSPACE_REQUIRED');
    const [tree, record, cleanup] = await Promise.all([options.journal.get<PreparedWorktree>('worktree:' + ref.id),
        options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + ref.id), options.journal.get('worktree-cleanup:' + ref.id)]);
    requireValue(tree && record && !cleanup && tree.directory === record.directory, 'OPERATION_WORKSPACE_UNAVAILABLE');
    requireValue(item.externalRefs?.some(row => row.system === 'nestos-remote-project' && row.id === record.projectId), 'WORKTREE_PROJECT_CHANGED');
    return {id: ref.id, tree, record};
}
async function snapshot(options: Options, board: KanbanBoard, item: KanbanItem): Promise<ReviewSnapshot> {
    const current = await resource(options, item, board.id), {record, tree} = current;
    requireValue((record.context as {board?: {id?: string}; task?: {id?: string}})?.board?.id === board.id
        && (record.context as {task?: {id?: string}})?.task?.id === item.id, 'OPERATION_WORKSPACE_SCOPE_MISMATCH');
    return developmentWorkspace(options.remote, options.provider, record.projectId, async process => {
        const status = await inspectWorktree(process, tree, '_nestos/kanban/'); requireValue(status.exists, 'WORKTREE_MISSING');
        const targetChanges = await gitWorkspace(process, '/workspace', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
        requireValue(!targetChanges.stdout.trim(), 'OPERATION_TARGET_DIRTY');
        const repositories = await verifyWorktreeDelivery(process, record.directory, record.repositories, record.policy.commit, record.availableRepositories);
        const {input: _input, ...commitContext} = record.commitContext ?? {};
        const sourceVersion = sha256HexSync(JSON.stringify([record.projectId, tree.id, repositories])), targetVersion = status.targetHead;
        return {sourceVersion, targetVersion, version: sha256HexSync(JSON.stringify([sourceVersion, status.targetBranch, targetVersion])),
            context: {...(record.commitContext ? {commitContext} : {}), commitPolicy: record.policy.commit, projectId: record.projectId, worktreeId: tree.id, directory: tree.directory, branch: tree.branch, sourceHead: status.head,
                targetBranch: status.targetBranch, targetHead: targetVersion, repositories}};
    });
}
async function prepareAnalysis(options: Options, input: {id: string; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}): Promise<SubmissionRequest> {
    const current = await resource(options, input.item, input.board.id), calls = await options.calls.list({sessionId: current.id});
    const reasons = await workResourceExecution(options, current.id, current.record.projectId); requireValue(!reasons.length, reasons[0] ?? 'OPERATION_ORIGINAL_SESSION_BUSY');
    const original = calls.find(row => row.receipt.executionSessionId && row.input.request.expectedTarget);
    requireValue(original?.receipt.executionSessionId && calls.every(row => row.callerState?.settled && row.executionTree?.settled), 'OPERATION_ORIGINAL_SESSION_UNAVAILABLE');
    const sessionId = original.receipt.executionSessionId, activity = await options.kernel.sessionActivity(sessionId);
    requireValue(!Object.entries(activity.counts).some(([key, count]) => ['running', 'queued', 'created', 'waiting', 'blocked', 'paused'].includes(key) && count > 0), 'OPERATION_ORIGINAL_SESSION_BUSY');
    const branch = original.input.request.expectedBranch!, catalog = await readContextCatalog(options.kernel, sessionId);
    const bindings = Object.values(catalog.value.bindings).filter(row => row.branchId === branch && row.connectionId === 'work-' + current.id);
    requireValue(bindings.length === 1 && bindings[0].validity === 'valid' && !bindings[0].activeOperation, 'OPERATION_ORIGINAL_CONTEXT_UNAVAILABLE');
    const binding = bindings[0], target = original.input.request.expectedTarget!, directory = current.record.directory + '/_nestos/kanban/review/' + input.id;
    await freezeAnalysis(options, current, input, sessionId, directory);
    return {expectedSessionId: sessionId, expectedBranch: branch, expectedTarget: target, target: {kind: target.kind, id: target.id, version: target.version},
        source: {kind: 'composer', text: mergeInstruction(input, directory), attachments: [], values: {}},
        submission: {id: input.id, source: {kind: 'conversation', ownerId: sessionId, id: input.id}},
        overrides: {...original.input.request.overrides, baseRoundId: undefined, newBranchName: undefined, branchMode: 'continue',
            harnessConversation: {mode: 'resume', bindingId: binding.id, expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}}};
}
async function freezeAnalysis(options: Options, current: ReviewResource,
    input: {id: string; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}, sessionId: string, directory: string): Promise<void> {
    const folder = await options.projects.get(current.record.projectId), view = await options.projects.openWorkspace(folder.path);
    try {
        const policy = await developmentPolicy(options.journal, options.fs, view.fs, input.id,
            {profile: current.record.policy.profile, commit: current.record.policy.commit, modules: current.record.policy.modules.join(',')});
        const preload = await options.journal.get('merge-context-preload:' + input.id) ?? await developmentWorkspace(options.remote, options.provider, current.record.projectId, process =>
            preloadCommitContexts({...options, record: current.record, process, targetHead: input.snapshot.targetVersion}));
        const context = await options.journal.update('merge-context-preload:' + input.id, old => old ?? preload);
        const contextText = JSON.stringify(context);
        await publishImmutableFile(view.fs, directory, 'commit-contexts.json', contextText);
        await initializeDevelopmentExchange(view.fs, directory, input.id);
        await publishPromptBundle(view.fs, directory, policy.prompts, {operationId: input.id, phase: 'merge-analysis', boardId: input.board.id,
            itemId: input.item.id, sessionId, input: current.record.context, commitContexts: {path: 'commit-contexts.json', sha256: sha256HexSync(contextText)}, sourceVersion: input.snapshot.sourceVersion, targetVersion: input.snapshot.targetVersion, resources: input.snapshot.context});
        await options.journal.update('worktree:' + input.id, old => old ?? current.tree);
        await options.journal.update('development-workspace:' + input.id, old => old ?? {...current.record, exchangeVersion: 2, worktreeId: current.id, communicationDirectory: directory, policy});
    } finally {await view.dispose();}
}
function mergeInstruction(input: {id: string; item: KanbanItem; snapshot: ReviewSnapshot}, directory: string): string {
    const relative = directory.replace('/workspace/', '');
    return JSON.stringify({dependencies: {lifecycle: {stage: 'postload.succeeded'}}, operation: {phase: 'merge-analysis', operationId: input.id},
        instruction: `The original development task is terminal. Continue in this SAME Session for READ-ONLY integration analysis; do not rerun development, create another Session or worktree, commit, merge, push, or modify source/main files. `
            + `Read ${relative}/manifest.json, commit-contexts.json (verify its manifest sha256; distinguish historical/current context), exchange.json and prompts/task-merge-pre.md when present. Compare the retained delivery with the target branch. `
            + `Return a plan payload {sourceVersion,targetVersion,summary,conflicts:[{id,path,reason,options:[{id,label,detail}]}]}. Every conflict needs explicit user-selectable alternatives; no choices are approved yet. `
            + `Use exactly sourceVersion ${input.snapshot.sourceVersion} and targetVersion ${input.snapshot.targetVersion}; report changed inputs instead of guessing. `
            + `If context is insufficient, follow exchange.json to publish a work-message/2 request and end this turn WITHOUT analysis.yaml, task result or lifecycle completion; the host resumes this SAME Session after writing replies. Never poll for replies. After final analysis read optional prompts/task-merge-post.md. Keep original commit policy and published delivery files unchanged. `
            + sessionFileResultPrompt(relative + '/analysis.yaml', input.id),
        task: {id: input.item.id, title: input.item.title, responsibility: input.item.responsibility, acceptance: input.item.acceptance}});
}
async function readAnalysis(options: Options, job: ReviewJob): Promise<unknown | undefined> {
    const board = await options.service.read(job.boardId), item = (await options.service.item(job.boardId, job.itemId)).item;
    requireValue((await snapshot(options, board, item)).version === job.snapshot.version, 'MERGE_PLAN_SOURCE_CHANGED');
    const current = await resource(options, item, board.id), folder = await options.projects.get(current.record.projectId), view = await options.projects.openWorkspace(folder.path);
    try {return await readSessionFileResult(view.fs, current.record.directory + '/_nestos/kanban/review/' + job.id + '/analysis.yaml', job.id, options.journal);}
    finally {await view.dispose();}
}
