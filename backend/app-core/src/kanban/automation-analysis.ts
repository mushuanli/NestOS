import {DEFAULT_KANBAN_WORK_TYPES} from '@itookit/kanban/contracts';
import {adoptDecomposition, validateSubtasks, type AnalysisSubtask} from './analysis-decomposition';
import {randomUUID, sha256HexSync, t} from '@itookit/common';
import {taskStat, type Kernel, type TaskCallResult} from '@itookit/durable-kernel';
import type {IndependentCallService} from '@itookit/llm-session';
import type {IndependentCallInput} from '@itookit/llm-session/contracts';
import type {TargetRef} from '@itookit/llm-flow/contracts';
import type {KanbanAnalysisStatus, KanbanBoard, KanbanItem, KanbanService, KanbanEstimate} from '@itookit/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {requireValue} from './validation';
import preset from '../presets/kanban-planning.json';

export interface AnalysisResult {ready: boolean; dependencies: string[]; reason: string; estimate?: KanbanEstimate; subtasks?:AnalysisSubtask[]}
interface Job {
    terminalOutcome?: 'succeeded' | 'failed' | 'cancelled';
    id: string; itemRevision: number; signature: string; input: IndependentCallInput;
    phase: 'prepared' | 'submitting' | 'settled'; status: KanbanAnalysisStatus; result?: AnalysisResult;
}
export interface AnalysisOptions {
    onAnalysis?: import('./personal-automation').PersonalKanbanAutomationOptions['onAnalysis'];
    prepareAnalysis?: import('./personal-automation').PersonalKanbanAutomationOptions['prepareAnalysis'];
    journal: KanbanAutomationJournal; calls: IndependentCallService; kernel: Pick<Kernel, 'task'>;
    prepareSession(id: string): Promise<string>; active(): boolean;
    log(input: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
const keyFor = (board: string, item: string) => 'analysis-current:' + JSON.stringify([board, item]);
export async function analysisStatus(journal: KanbanAutomationJournal, board: string, item: string): Promise<KanbanAnalysisStatus | null> {
    const key = await journal.get<string>(keyFor(board, item));
    return key ? (await journal.get<Job>(key))?.status ?? null : await journal.get<KanbanAnalysisStatus>('decomposition-status:'+JSON.stringify([board,item]))??null;
}
export function analysisSignature(board: KanbanBoard): string {
    return sha256HexSync(JSON.stringify([board.automation, board.items.map(item => [item.id, item.title, item.responsibility, item.acceptance, item.planning])]));
}
export async function analyzeItem(options: AnalysisOptions, board: KanbanBoard, item: KanbanItem, target: TargetRef | undefined, service: KanbanService): Promise<void> {
    const started = Date.now();
    if (!options.active()) return;
    const loaded = await loadJob(options, board, item, target);
    if (!loaded || !options.active()) return;
    const {key} = loaded; let {job} = loaded;
    if (job.phase === 'prepared') job = await submitAnalysis(options, key, job);
    if (!options.active()) return;
    if (job.phase === 'submitting') job = await observeAnalysis(options, key, job);
    job = await finalizeAnalysis(options, board.id, item, key, job);
    if (job.result?.ready && job.status.state === 'ready' && board.automation?.enabled && options.active()) {
        try {await adoptAnalysis(options.journal, board, item, job, service);}
        catch (error) {await saveFailure(options, key, job, safeCode(error, 'AUTOMATION_PLAN_REJECTED'));}
    }
    if (!options.active()) return;
    const status = (await options.journal.get<Job>(key))?.status;
    options.log({operationId: job.id, stage: 'automation.analysis', result: status?.state === 'failed' || status?.state === 'unknown' ? 'failure' : 'success', code: status?.code, durationMs: Date.now() - started});
}
async function finalizeAnalysis(options: AnalysisOptions, boardId: string, item: KanbanItem, key: string, job: Job): Promise<Job> {
    if (!options.active() || job.phase !== 'settled' || !options.onAnalysis) return job;
    try {
        await options.onAnalysis({boardId, id: job.id, item, target: job.input.request.expectedTarget!,
            outcome: job.terminalOutcome ?? (job.status.state === 'failed' ? 'failed' : 'succeeded'), code: job.status.code});
        return job;
    } catch (error) {return options.active() ? saveFailure(options, key, job, safeCode(error, 'AUTOMATION_ANALYSIS_FINALIZATION_FAILED')) : job;}
}
async function loadJob(options: AnalysisOptions, board: KanbanBoard, item: KanbanItem, target?: TargetRef) {
    requireValue(board.items.length <= 200, 'AUTOMATION_CONTEXT_LIMIT');
    const signature = analysisSignature(board), currentKey = await options.journal.get<string>(keyFor(board.id, item.id));
    const currentJob = currentKey ? await options.journal.get<Job>(currentKey) : undefined;
    if (!board.automation?.enabled && currentJob?.phase !== 'submitting') return;
    const key = currentJob?.phase === 'submitting' ? currentKey! : 'analysis:' + sha256HexSync(JSON.stringify([board.id, item.id, item.revision, signature]));
    let job = await options.journal.get<Job>(key);
    if (!job) {
        requireValue(target, 'AUTOMATION_TARGET_CHANGED');
        const id = await options.journal.update<string>('analysis-identity:' + key, old => old ?? randomUUID());
        const prepared = await options.prepareAnalysis?.({id, board, item, target});
        const candidate = newJob(board, item, prepared?.target ?? target, signature, id, prepared?.instruction);
        job = await options.journal.update<Job>(key, previous => previous ?? candidate);
    }
    if (!options.active()) return;
    await options.journal.update(keyFor(board.id, item.id), () => key);
    if (!options.active()) return;
    return {key, job};
}
function newJob(board: KanbanBoard, item: KanbanItem, target: TargetRef, signature: string, id = randomUUID(), instruction = preset.instruction): Job {
    const context = board.items.map(({id, title, responsibility, acceptance, planning, status}) => ({id, title, responsibility, acceptance, planning, status}));
    return {id, signature, itemRevision: item.revision, phase: 'prepared', status: {itemId: item.id, state: 'analyzing'},
        input: {title: t('kanban.automationAnalysis'), request: {expectedSessionId: id, expectedBranch: 'main', expectedTarget: target,
            target: {kind: target.kind, id: target.id, version: target.version},
            source: {kind: 'composer', text: JSON.stringify({instruction, snapshot: {item, items: context, workTypes:board.workTypes??DEFAULT_KANBAN_WORK_TYPES, defaultWorkType:board.defaultWorkType??'task'}}), attachments: [], values: {}},
            submission: {id, source: {kind: 'conversation', ownerId: id, id}}}}};
}
async function submitAnalysis(options: AnalysisOptions, key: string, job: Job): Promise<Job> {
    try {
        await options.prepareSession(job.id);
        await options.calls.prepareTaskCall(job.input, {maxDepth: 4, timeoutMs: 120000});
    } catch (error) {return options.active() ? saveFailure(options, key, job, safeCode(error, 'AUTOMATION_ANALYSIS_PREPARE_FAILED')) : job;}
    if (!options.active()) return job;
    const claimed = await options.journal.claim(key), latest = (await options.journal.get<Job>(key))!;
    if (!claimed || !options.active()) return latest;
    try {await options.calls.submitPreparedTaskCall(job.input);}
    catch {return options.active() ? options.journal.update<Job>(key, current => current!.phase === 'submitting' ? {...current!, status: {...job.status, state: 'unknown', code: 'AUTOMATION_ADMISSION_UNKNOWN'}} : current!) : latest;}
    return latest;
}
async function observeAnalysis(options: AnalysisOptions, key: string, job: Job): Promise<Job> {
    const admission = await options.calls.inspectTaskCallSubmission(job.input);
    if (!options.active()) return job;
    if (!admission) return options.journal.update<Job>(key, current => current!.phase === 'submitting' ? {...current!, status: {...job.status, state: 'unknown', code: 'AUTOMATION_ADMISSION_UNKNOWN'}} : current!);
    const views = await options.calls.list({sessionId: job.id, branchId: 'main'});
    const view = views.find(view => view.input.request.submission?.id === job.id);
    if (!view?.callerState?.settled || !view.executionTree?.settled) return job;
    const record = await options.kernel.task(admission.submission.task.sessionId, admission.submission.task.taskId);
    if (!options.active()) return job;
    if (!taskStat(record).settled) return job;
    const result = record.exit?.output as TaskCallResult | undefined;
    if (record.exit?.status !== 'succeeded' || result?.exit.status !== 'succeeded') return saveFailure(options, key, job, 'AUTOMATION_ANALYSIS_FAILED', record.exit?.status === 'cancelled' || result?.exit.status === 'cancelled' ? 'cancelled' : 'failed');
    try {
        const analysis = parseAnalysis(result.exit.output);
        return options.journal.update<Job>(key, current => ({...current!, phase: 'settled', result: analysis,
            status: {itemId: job.status.itemId, state: analysis.ready ? 'ready' : 'clarification', reason: analysis.reason, dependencies: analysis.dependencies}}));
    } catch (error) {return saveFailure(options, key, job, safeCode(error, 'AUTOMATION_ANALYSIS_INVALID'));}
}
export function parseAnalysis(output: unknown): AnalysisResult {
    const value = output as {message?: {content?: unknown}; nodes?: Record<string, {outputs?: Record<string, unknown>}>};
    let text = value?.message?.content ?? value?.nodes?.__flow_return?.outputs?.analysis ?? value?.nodes?.__flow_return?.outputs?.result ?? output;
    if (text && typeof text === 'object' && 'content' in text) text = text.content;
    const result = (typeof text === 'string' ? JSON.parse(text) : text) as AnalysisResult;
    requireValue(result && typeof result.ready === 'boolean' && typeof result.reason === 'string' && result.reason.length > 0 && result.reason.length <= 8000, 'AUTOMATION_ANALYSIS_INVALID');
    requireValue(Array.isArray(result.dependencies) && result.dependencies.length <= 100 && result.dependencies.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256), 'AUTOMATION_DEPENDENCIES_INVALID');
    if (result.estimate) requireValue(['low', 'medium', 'high'].includes(result.estimate.confidence)
        && [result.estimate.complexity, result.estimate.workUnits, result.estimate.durationMs].every(value => Number.isFinite(value) && value > 0), 'AUTOMATION_ESTIMATE_INVALID');
    const subtasks=validateSubtasks(result.subtasks);
    return {ready: result.ready, reason: result.reason, dependencies: [...new Set(result.dependencies)], ...(subtasks?{subtasks}:{}), ...(result.estimate ? {estimate: result.estimate} : {})};
}
async function adoptAnalysis(journal:KanbanAutomationJournal, snapshot: KanbanBoard, item: KanbanItem, job: Job, service: KanbanService): Promise<void> {
    if ((await service.workflow(snapshot.id)).plans[job.id]) return;
    const board = await service.read(snapshot.id), current = board.items.find(candidate => candidate.id === item.id);
    requireValue(board.automation?.enabled && current?.revision === job.itemRevision && analysisSignature(board) === job.signature, 'AUTOMATION_ANALYSIS_STALE');
    requireValue(board.policy.requireEstimate === false || job.result?.estimate, 'ESTIMATE_REQUIRED');
    const dependencies = [...new Set([...(item.planning?.dependencies ?? []), ...job.result!.dependencies])];
    if(job.result?.subtasks?.length) return adoptDecomposition(journal,board,item,{id:job.id,reason:job.result.reason,dependencies,subtasks:job.result.subtasks},service);
    await service.execute(board.id, {operationId: 'analysis-plan:' + job.id, expectedRevision: board.revision, command: {type: 'publish-plan', plan: {
        schema: 'kanban.plan/1', id: job.id, revision: 1, sealed: true,
        items: [{id: item.id, title: item.title, responsibility: item.responsibility, acceptance: item.acceptance,
            expectedRevision: job.itemRevision, assignee: board.automation.worker, dependsOn: dependencies, outputs: ['result']}],
    }}});
}
function saveFailure(options: AnalysisOptions, key: string, job: Job, code: string, terminalOutcome: 'failed' | 'cancelled' = 'failed'): Promise<Job> {
    return options.journal.update<Job>(key, current => ({...current!, phase: 'settled', terminalOutcome, status: {itemId: job.status.itemId, state: 'failed', code}}));
}
export function safeCode(error: unknown, fallback: string): string {
    const code = (error as {code?: unknown})?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}
