import type {KanbanBoard, KanbanItem, KanbanItemOperationRequest} from '@itookit/kanban/contracts';
import {sha256HexSync} from '@itookit/common';
import {automationTarget} from './automation-targets';
import {requireValue} from './validation';
import {safeCode} from './automation-analysis';
import {journalCommand} from './journal-command';
import {jobKey, type ReviewJob, type ReviewOperationsOptions, type ReviewSettings, type ReviewAction, type MergePlan} from './item-operation-types';

export async function prepareReviewJob(options: ReviewOperationsOptions, board: KanbanBoard, item: KanbanItem,
    settings: ReviewSettings, request: KanbanItemOperationRequest, context?: unknown): Promise<ReviewJob> {
    const snapshot = await options.adapter.snapshot(board, item), action = request.action as ReviewAction;
    const base: ReviewJob = {id: request.operationId, boardId: board.id, itemId: item.id, action, snapshot,
        fingerprint: sha256HexSync(JSON.stringify(request)), phase: 'prepared', state: 'running', createdAt: Date.now()};
    if (action === 'analyze') {const request = await options.adapter.prepareAnalysis({id: base.id, board, item, snapshot}); return {...base, request, sessionId: request.expectedSessionId};}
    if (action === 'deploy' || action === 'merge') {
        const evidence = context as {sourceVersion?: string; targetVersion?: string};
        requireValue(evidence?.sourceVersion === snapshot.sourceVersion && evidence.targetVersion === snapshot.targetVersion, 'OPERATION_SOURCE_CHANGED_REANALYZE');
    }
    const binding = settings.bindings[action]; requireValue(binding, 'OPERATION_FLOW_REQUIRED');
    const target = automationTarget(binding, await options.catalog()); requireValue(target.kind === 'flow', 'OPERATION_FLOW_REQUIRED');
    return {...base, input: {title: item.title, request: {expectedSessionId: base.id, expectedBranch: 'main', target: {kind: target.kind, id: target.id, version: target.version},
        expectedTarget: target, source: {kind: 'composer', text: '', attachments: [], values: {context: JSON.stringify({schema: 'nestos.kanban.operation/1', operationId: base.id,
            action, boardId: board.id, itemId: item.id, sourceVersion: snapshot.sourceVersion, targetVersion: snapshot.targetVersion, resources: snapshot.context, input: context})}},
        submission: {id: base.id, source: {kind: 'conversation', ownerId: base.id, id: base.id}}}}};
}
export async function advanceReviewJob(options: ReviewOperationsOptions, job: ReviewJob): Promise<ReviewJob> {
    if (job.phase === 'settled') return job;
    const started = Date.now();
    try {
        if (job.action === 'accept') return await acceptReview(options, job);
        if (job.phase === 'prepared') {
            if (!await options.journal.claim(jobKey(job.id))) return (await options.journal.get<ReviewJob>(jobKey(job.id)))!;
            job = {...job, phase: 'submitting'};
            if (job.request) await options.submission.start(job.request); else await options.published.start(job.input!);
        }
        if (job.phase === 'settled') return job;
        const observation = job.request ? await options.submission.inspect(job.request).then(row => ({state: row.outcome === 'cancelled' ? 'failed' as const : row.outcome, sessionId: row.sessionId, code: row.code, output: undefined}))
            : await options.published.inspect(job.input!);
        if (!['succeeded', 'failed'].includes(observation.state)) return save(options, job, {...job, state: observation.state, sessionId: observation.sessionId, code: observation.code});
        const output = observation.state === 'succeeded' ? job.request ? await options.adapter.readAnalysis(job) : observation.output : undefined;
        if (observation.state === 'succeeded' && output === undefined) return save(options, job, {...job, state: 'unknown', code: 'OPERATION_RESULT_PENDING', sessionId: observation.sessionId});
        if (observation.state === 'succeeded') validateOperationResult(job, output);
        if (observation.state === 'succeeded' && job.action === 'deploy')
            requireValue(options.adapter.runningVersion?.() === (output as {version: string}).version, 'OPERATION_RESULT_RUNNING_VERSION_MISMATCH');
        const next = {...job, phase: 'settled' as const, state: observation.state as 'succeeded' | 'failed', result: output, sessionId: observation.sessionId, code: observation.code};
        const saved = await save(options, job, next);
        options.log({operationId: job.id, stage: 'review.' + job.action, result: saved.state === 'succeeded' ? 'success' : 'failure', code: saved.code, durationMs: Date.now() - started});
        return saved;
    } catch (error) {
        const code = safeCode(error, 'OPERATION_OBSERVATION_FAILED'), notStarted = (error as {executionOutcome?: string})?.executionOutcome === 'not-started';
        const retry = notStarted && (error as {retryable?: boolean}).retryable === true || code === 'REVISION_CONFLICT';
        const terminal = notStarted && !retry || code.startsWith('OPERATION_RESULT_') || code.startsWith('MERGE_PLAN_') || code.startsWith('OPERATION_SOURCE_CHANGED') || code === 'OPERATION_RUNNING_VERSION_MISMATCH';
        if (job.code !== code || terminal && job.phase !== 'settled' || retry && job.phase !== 'prepared')
            options.log({operationId: job.id, stage: 'review.' + job.action, result: 'failure', code, durationMs: Date.now() - started});
        return save(options, job, {...job, phase: retry ? 'prepared' : terminal ? 'settled' : job.phase, state: terminal ? 'failed' : 'unknown', code});
    }
}
async function acceptReview(options: ReviewOperationsOptions, job: ReviewJob): Promise<ReviewJob> {
    const {item} = await options.service.item(job.boardId, job.itemId), command = job.command!;
    requireValue(command.type === 'accept-execution', 'OPERATION_REQUEST_INVALID');
    const accepted = (await options.service.workflow(job.boardId)).dispatches[command.dispatchId]?.outcome === 'accepted';
    if (!(item.status === 'completed' && accepted)) {
        requireValue((await options.adapter.snapshot(await options.service.read(job.boardId), item)).version === job.snapshot.version, 'OPERATION_SOURCE_CHANGED_REBUILD');
        requireValue(options.adapter.runningVersion?.() === job.acceptanceVersion, 'OPERATION_RUNNING_VERSION_MISMATCH');
        await journalCommand(options.journal, options.service, job.boardId, 'review-accept:' + job.id, command);
    }
    return save(options, job, {...job, phase: 'settled', state: 'succeeded'});
}
async function save(options: ReviewOperationsOptions, previous: ReviewJob, next: ReviewJob): Promise<ReviewJob> {
    if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
    const saved = await options.journal.update<ReviewJob>(jobKey(previous.id), current => {
        requireValue(current?.fingerprint === previous.fingerprint, 'OPERATION_IDENTITY_CONFLICT');
        return current.phase === 'settled' ? current : next;
    });
    await options.report?.(saved); return saved;
}
function validateOperationResult(job: ReviewJob, output: unknown): void {
    const value = output as {schema?: string; operationId?: string; sourceVersion?: string; targetVersion?: string; version?: string};
    if (job.action === 'analyze') {validateMergePlan(output, job); return;}
    requireValue(value?.schema === 'nestos.kanban.operation-result/1' && value.operationId === job.id, 'OPERATION_RESULT_INVALID');
    requireValue(value.sourceVersion === job.snapshot.sourceVersion && value.targetVersion === job.snapshot.targetVersion, 'OPERATION_RESULT_SCOPE_MISMATCH');
    if (job.action === 'build' || job.action === 'deploy') requireValue(typeof value.version === 'string' && /^[\w.+-]{1,128}$/.test(value.version), 'OPERATION_RESULT_VERSION_REQUIRED');
    if (job.action === 'deploy') requireValue(value.version === JSON.parse((job.input!.request.source as {values: Record<string, string>}).values.context).input.version, 'OPERATION_RESULT_VERSION_MISMATCH');
}
export function validateMergePlan(value: unknown, job: ReviewJob): asserts value is MergePlan {
    const plan = value as MergePlan;
    requireValue(plan && plan.sourceVersion === job.snapshot.sourceVersion && plan.targetVersion === job.snapshot.targetVersion
        && typeof plan.summary === 'string' && plan.summary.length <= 8000 && Array.isArray(plan.conflicts) && plan.conflicts.length <= 100, 'MERGE_PLAN_INVALID');
    const ids = new Set<string>();
    for (const conflict of plan.conflicts) {
        requireValue(/^[\w.-]{1,128}$/.test(conflict.id) && !['__proto__', 'constructor', 'prototype'].includes(conflict.id) && !ids.has(conflict.id) && typeof conflict.path === 'string' && conflict.path.length <= 4096
            && typeof conflict.reason === 'string' && conflict.reason.length <= 4000 && Array.isArray(conflict.options) && conflict.options.length > 0 && conflict.options.length <= 8, 'MERGE_PLAN_CONFLICT_INVALID');
        ids.add(conflict.id); const options = new Set<string>();
        for (const option of conflict.options) {
            requireValue(/^[\w.-]{1,128}$/.test(option.id) && !options.has(option.id) && typeof option.label === 'string' && option.label.length <= 256
                && (option.detail === undefined || typeof option.detail === 'string' && option.detail.length <= 4000), 'MERGE_PLAN_OPTION_INVALID'); options.add(option.id);
        }
    }
}
