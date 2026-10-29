import type {TwinScannerExecutor} from '@itookit/app-contracts';
import type {IndependentCallService, SessionRepository} from '@itookit/llm-session';
import {KernelError, KernelErrorCode, type Kernel, type TaskCallResult} from '@itookit/durable-kernel';
import type {DagRunSpec} from '@itookit/llm-flow/contracts';
import {traceAnalysis, TwinDiagnosticError} from './diagnostics';

export interface TwinCollectionRequest {runId: string; sessionId: string; executor: TwinScannerExecutor}
export interface TwinCollectionPort {
    collect(request: TwinCollectionRequest, attached: (taskId: string) => Promise<void>, bind: (sessionId: string) => Promise<void>): Promise<void>;
    cancelCollection(sessionId: string, taskId?: string): Promise<void>;
}
interface Options {kernel: Kernel; repository: SessionRepository; ready(): {calls: IndependentCallService}}

/** Collection is a published static Tool Flow. It cannot spend unmetered model tokens. */
export class PublishedScannerCollector implements TwinCollectionPort {
    constructor(private readonly options: Options) {}
    async collect(request: TwinCollectionRequest, attached: (taskId: string) => Promise<void>, bind: (sessionId: string) => Promise<void>): Promise<void> {
        const started = Date.now(), identity = {sessionId: request.sessionId, connectionId: ''};
        traceAnalysis(identity, 'collection.prepare', {operationId: request.runId});
        try {
            await this.execute(request, attached, bind);
            traceAnalysis(identity, 'collection.completed', {operationId: request.runId, durationMs: Date.now() - started});
        } catch (error) {
            try {await this.cancelCollection(request.sessionId);} catch {
                traceAnalysis(identity, 'failed', {operationId: request.runId, category: 'collection-cancel-unconfirmed', durationMs: Date.now() - started});
            }
            traceAnalysis(identity, 'failed', {operationId: request.runId, category: 'collection-execution', durationMs: Date.now() - started});
            throw error;
        }
    }
    private async execute(request: TwinCollectionRequest, attached: (taskId: string) => Promise<void>, bind: (sessionId: string) => Promise<void>): Promise<void> {
        const {repository, kernel} = this.options, calls = this.options.ready().calls;
        await repository.ensureSession(request.sessionId, 'Source collection');
        const input = {title: 'Source collection', request: {expectedSessionId: request.sessionId, expectedBranch: 'main', expectedTarget: request.executor.target,
            target: {kind: request.executor.target.kind, id: request.executor.target.id, version: request.executor.target.version},
            source: {kind: 'composer' as const, text: '', attachments: [], values: request.executor.values ?? {}},
            submission: {id: 'collect', source: {kind: 'conversation' as const, ownerId: request.sessionId, id: 'collect'}}}};
        const ready = await calls.prepareTaskCall(input, {maxDepth: 1, timeoutMs: 150000});
        assertCollectionPlan(ready.plan.task);
        await bind(ready.executionSessionId);
        const result = await calls.submitPreparedTaskCall(input), taskId = result.submission.task.taskId;
        const task = await kernel.attachTask(request.sessionId, taskId);
        try {await attached(taskId);} catch (error) {await task.cancel(undefined, {requestId: 'collection-cancel'}); throw error;}
        const exit = await task.wait({until: 'settled', timeoutMs: 180000}), output = exit.output as TaskCallResult | undefined;
        if (exit.status !== 'succeeded' || output?.exit.status !== 'succeeded') {
            const message = output?.exit.error?.message ?? exit.error?.message ?? '';
            const code = message.match(/\b(?:GOOGLE|TOOL_CONNECTION)_[A-Z_]+\b/)?.[0];
            throw new TwinDiagnosticError('TWIN_COLLECTION_FAILED', {message: code ?? 'Collection task did not succeed'});
        }
    }
    async cancelCollection(sessionId: string, taskId?: string): Promise<void> {
        const tasks = await this.options.kernel.listSessionTasks(sessionId).catch(error => {
            if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return [];
            throw error;
        });
        const task = taskId ? tasks.find(task => task.id === taskId) : tasks.find(task => task.program.kind === 'kernel.call');
        if (task) await (await this.options.kernel.attachTask(sessionId, task.id)).cancel(undefined, {requestId: 'collection-cancel'});
    }
}
export function assertCollectionPlan(value: unknown): void {
    const task = value as {program?: {kind?: string}; input?: {initialScheduler?: {spec?: DagRunSpec}}};
    const graph = task.input?.initialScheduler?.spec;
    if (task.program?.kind !== 'flow.aggregate' || !graph || Object.keys(graph.functionCalls ?? {}).length
        || graph.nodes.some(node => !['builtin.tool', 'builtin.transform', 'builtin.return'].includes(node.plugin)))
        throw new Error('TWIN_COLLECTION_STATIC_TOOLS_REQUIRED');
}
