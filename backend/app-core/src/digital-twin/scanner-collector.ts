import {collectWithTool, type ToolCollectorOptions} from './tool-collector';
import {collectionTools, presentCollectionTools, validateCollectionTool} from './collection-tools';
import type {TwinCollectionExecutor} from '@itookit/app-contracts';
import type {IndependentCallService, SessionRepository} from '@itookit/llm-session';
import {KernelError, KernelErrorCode, type Kernel, type TaskCallResult} from '@itookit/durable-kernel';
import type {DagRunSpec} from '@itookit/llm-flow/contracts';
import {traceAnalysis, TwinDiagnosticError} from './diagnostics';
import {collectionProgress} from './collection-progress';
type Progress = import('@itookit/app-contracts').TwinCollectionProgress;

export interface TwinCollectionRequest {runId: string; sessionId: string; executor: TwinCollectionExecutor}
export interface TwinCollectionPort {
    tools?(): import('@itookit/app-contracts').TwinScannerTool[] | Promise<import('@itookit/app-contracts').TwinScannerTool[]>;
    validate?(executor: TwinCollectionExecutor): void;
    collect(request: TwinCollectionRequest, attached: (taskId: string) => Promise<void>, bind: (sessionId: string) => Promise<void>): Promise<Progress | void>;
    cancelCollection(sessionId: string, taskId?: string): Promise<void>;
}
interface Options {tools?: ToolCollectorOptions; packages?: Pick<import('@itookit/app-contracts/services').ToolDependencyResolver, 'list'>; kernel: Kernel; repository: SessionRepository; ready(): {calls: IndependentCallService}}

/** Collection runs a fixed Tool or a published static Tool Flow, without model access. */
export class PublishedScannerCollector implements TwinCollectionPort {
    constructor(private readonly options: Options) {}
    async tools() {
        const tools = this.options.tools ? collectionTools(this.options.tools.tools) : [];
        return presentCollectionTools(tools, await this.options.packages?.list?.() ?? []);
    }
    validate(executor: TwinCollectionExecutor): void {
        if (executor.target.kind === 'tool') {
            if (!this.options.tools) throw new Error('TWIN_SCANNER_EXECUTOR_UNAVAILABLE');
            validateCollectionTool(this.options.tools.tools, executor);
        }
    }
    async collect(request: TwinCollectionRequest, attached: (taskId: string) => Promise<void>, bind: (sessionId: string) => Promise<void>): Promise<Progress | undefined> {
        const started = Date.now(), identity = {sessionId: request.sessionId, connectionId: ''};
        traceAnalysis(identity, 'collection.prepare', {operationId: request.runId});
        try {
            let progress: Progress | undefined;
            if (request.executor.target.kind === 'tool') {
                if (!this.options.tools) throw new Error('TWIN_SCANNER_EXECUTOR_UNAVAILABLE');
                progress = await collectWithTool(this.options.tools, request, attached, bind);
            } else progress = await this.execute(request, attached, bind);
            traceAnalysis(identity, 'collection.completed', {operationId: request.runId, complete: progress?.complete, processed: progress?.processed, durationMs: Date.now() - started});
            return progress;
        } catch (error) {
            try {await this.cancelCollection(request.sessionId);} catch {
                traceAnalysis(identity, 'failed', {operationId: request.runId, category: 'collection-cancel-unconfirmed', durationMs: Date.now() - started});
            }
            traceAnalysis(identity, 'failed', {operationId: request.runId, category: 'collection-execution', durationMs: Date.now() - started});
            throw error;
        }
    }
    private async execute(request: TwinCollectionRequest, attached: (taskId: string) => Promise<void>, bind: (sessionId: string) => Promise<void>): Promise<Progress | undefined> {
        if (request.executor.target.kind !== 'flow') throw new Error('TWIN_COLLECTION_TARGET_INVALID');
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
            const code = message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0];
            throw new TwinDiagnosticError('TWIN_COLLECTION_FAILED', {message: code ?? 'Collection task did not succeed'});
        }
        return collectionProgress(output.exit.output);
    }
    async cancelCollection(sessionId: string, taskId?: string): Promise<void> {
        const tasks = await this.options.kernel.listSessionTasks(sessionId).catch(error => {
            if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return [];
            throw error;
        });
        const task = taskId ? tasks.find(task => task.id === taskId) : tasks.find(task => task.program.kind === 'kernel.call');
        if (task) {
            const handle = await this.options.kernel.attachTask(sessionId, task.id);
            await handle.cancel(undefined, {requestId: 'collection-cancel'}); await handle.wait({until: 'settled', timeoutMs: 180000});
        }
    }
}
export function assertCollectionPlan(value: unknown, expected?: TwinCollectionExecutor): void {
    const task = value as {program?: {kind?: string}; input?: {initialScheduler?: {spec?: DagRunSpec}}};
    if (expected?.target.kind === 'tool') {
        const input = (task as {input?: {toolId?: string; toolVersion?: string; args?: unknown}}).input;
        if (task.program?.kind !== 'kernel-adapters.tool' || input?.toolId !== expected.target.id || input?.toolVersion !== expected.target.version
            || JSON.stringify(input?.args) !== JSON.stringify(expected.values ?? {})) throw new Error('TWIN_COLLECTION_TARGET_INVALID');
        return;
    }
    const graph = task.input?.initialScheduler?.spec;
    if (task.program?.kind !== 'flow.aggregate' || !graph || Object.keys(graph.functionCalls ?? {}).length
        || graph.nodes.some(node => !['builtin.tool', 'builtin.transform', 'builtin.return'].includes(node.plugin)))
        throw new Error('TWIN_COLLECTION_STATIC_TOOLS_REQUIRED');
}
