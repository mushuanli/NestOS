import type {IndependentCallService} from '@itookit/llm-session';
import type {IndependentCallInput} from '@itookit/llm-session/contracts';
import type {TargetRef, DagRunSpec} from '@itookit/llm-flow/contracts';
import {nodeOutputEntries} from '@itookit/llm-flow/contracts';
import type {Kernel, TaskCallResult} from '@itookit/durable-kernel';
import type {KanbanDiscoveryChange, KanbanScanConnection, KanbanScanInput} from '@itookit/kanban/contracts';
import type {KanbanScanExecutor} from '@itookit/kanban/discovery';
import {requireValue} from './validation';
import {KanbanError} from '@itookit/kanban';
import {KanbanScanNotStartedError} from '@itookit/kanban/discovery';

interface PublishedOptions {
    calls: IndependentCallService; kernel: Kernel; target: TargetRef;
    /** Prepare an isolated scanner Session, excluded by the project's source catalog. */
    prepareSession(runId: string): Promise<string>;
}
export function createPublishedKanbanExecutor(options: PublishedOptions): KanbanScanExecutor {
    requireValue(options.target.kind === 'flow', 'SCANNER_FLOW_REQUIRED');
    const target = structuredClone(options.target);
    return {identity: JSON.stringify(target), settled: input => hasSettled(options, input), async run(input) {
        const sessionId = await options.prepareSession(input.runId);
        const request: IndependentCallInput = {title: 'Kanban discovery', request: {
            expectedSessionId: sessionId, expectedBranch: 'main', expectedTarget: target,
            target: {kind: target.kind, id: target.id, version: target.version},
            source: {kind: 'composer', text: JSON.stringify(input), attachments: [], values: {}},
            ...(input.connection.kind === 'local' ? {overrides: {connectionId: input.connection.connectionId, flowConnectionBindings: {analysis: input.connection.connectionId}}} : {}),
            submission: {id: input.runId, source: {kind: 'conversation', ownerId: sessionId, id: input.runId}},
        }};
        try {
            const prepared = await options.calls.prepareTaskCall(request, {maxDepth: 4, timeoutMs: 120000});
            verifyScanPlan(prepared.plan.task, input.connection);
        } catch (error) {throw new KanbanScanNotStartedError(error instanceof KanbanError ? error.code : 'SCANNER_PREPARATION_FAILED');}
        const admission = await options.calls.submitPreparedTaskCall(request);
        const caller = await options.kernel.attachTask(sessionId, admission.submission.task.taskId);
        const exit = await caller.wait({until: 'settled', timeoutMs: 150000});
        const result = exit.output as TaskCallResult | undefined;
        requireValue(exit.status === 'succeeded' && result?.exit.status === 'succeeded', 'SCANNER_FLOW_FAILED');
        return parseOutput(result.exit.output);
    }};
}
function parseOutput(output: unknown): KanbanDiscoveryChange[] | import('@itookit/kanban/contracts').KanbanDiscoveryResult {
    const returned = (output as {nodes?: Record<string, unknown>})?.nodes?.__flow_return;
    requireValue(returned, 'SCANNER_RETURN_MISSING');
    const entries = nodeOutputEntries(returned);
    const value = entries.find(e => e.name === 'changes')?.value;
    let decoded: unknown;
    try {decoded = typeof value === 'string' ? JSON.parse(value) : value;}
    catch {requireValue(false, 'INVALID_SCAN_OUTPUT');}
    const changes = (decoded as {changes?: unknown})?.changes;
    requireValue(Array.isArray(changes), 'INVALID_SCAN_OUTPUT');
    const records = (decoded as {records?: unknown})?.records;
    requireValue(records === undefined || Array.isArray(records), 'INVALID_SCAN_OUTPUT');
    return records === undefined ? changes as KanbanDiscoveryChange[] : {changes: changes as KanbanDiscoveryChange[], records: records as import('@itookit/kanban/contracts').KanbanRecordInput[]};
}

function verifyScanPlan(value: unknown, connection: KanbanScanConnection): void {
    const task = value as {program?: {kind?: string}; input?: {initialScheduler?: {spec?: DagRunSpec}}};
    requireValue(task.program?.kind === 'flow.aggregate', 'SCANNER_FLOW_REQUIRED');
    const nodes = task.input?.initialScheduler?.spec?.nodes;
    requireValue(nodes?.length && nodes.length <= 8, 'SCANNER_PLAN_LIMIT');
    let models = 0;
    for (const node of nodes) {
        requireValue(['builtin.agent', 'builtin.return', 'builtin.transform'].includes(node.plugin), 'SCANNER_PLAN_UNSUPPORTED');
        if (node.plugin !== 'builtin.agent') continue;
        models++;
        const config = node.config as {execution?: {kind: string; connectionId: string}; connectionId?: string; toolIds?: unknown[]; delegation?: unknown; subtasks?: unknown};
        requireValue(!config.toolIds?.length && !config.delegation && !config.subtasks, 'SCANNER_TOOLS_FORBIDDEN');
        if (connection.kind === 'remote') requireValue(config.execution?.kind === 'harness' && config.execution.connectionId === connection.connectionId, 'SCANNER_CONNECTION_MISMATCH');
        else requireValue(config.execution?.kind !== 'harness' && config.connectionId === connection.connectionId, 'SCANNER_CONNECTION_MISMATCH');
    }
    requireValue(models === 1, 'SCANNER_MODEL_COUNT');
}

async function hasSettled(options: PublishedOptions, input: KanbanScanInput): Promise<boolean> {
    const sessionId = await options.prepareSession(input.runId);
    const callers = (await options.kernel.listSessionTasks(sessionId)).filter(task => task.program.kind === 'kernel.call');
    if (!callers.length) return false;
    for (const caller of callers) if (!(await (await options.kernel.attachTask(sessionId, caller.id)).stat()).settled) return false;
    return true;
}
