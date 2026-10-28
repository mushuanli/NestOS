import type {TwinScannerExecutor} from '@itookit/app-contracts';
import type {ICommandBus, IndependentCallInput, RootTargetCatalog} from '@itookit/llm-session/contracts';
import {SessionCommand} from '@itookit/llm-session/contracts';
import type {IndependentCallService, SessionRepository} from '@itookit/llm-session';
import type {Kernel, TaskCallResult} from '@itookit/durable-kernel';
import {parseCandidates, type TwinExtractionPort} from './extraction';
import type {TwinAnalysisJob} from './domain';
import {traceAnalysis, TwinDiagnosticError} from './diagnostics';

export interface TwinScannerExecutionPort extends TwinExtractionPort {
    catalog(): Promise<RootTargetCatalog>;
    validate(executor: TwinScannerExecutor): Promise<void>;
}
interface Options {
    kernel: Kernel; repository: SessionRepository;
    ready(): {commands: ICommandBus; calls: IndependentCallService};
    exchanges?(job: TwinAnalysisJob): Promise<number>;
    bind(job: TwinAnalysisJob, sessionId: string): Promise<void>;
}
/** Published calls own execution; the scanner only validates and accepts their result. */
export class PublishedScannerExecutor implements TwinScannerExecutionPort {
    constructor(private readonly options: Options) {}
    catalog() {return this.options.ready().commands.execute<RootTargetCatalog>(SessionCommand.ListTargets);}
    async validate(executor: TwinScannerExecutor): Promise<void> {
        const catalog = await this.catalog();
        if (!catalog.entries.some(item => item.target.kind === executor.target.kind && item.target.id === executor.target.id && item.target.version === executor.target.version && item.target.digest === executor.target.digest)) throw new Error('TWIN_SCANNER_TARGET_CHANGED');
    }
    async run(job: TwinAnalysisJob, text: string, attached: (id: string) => Promise<void>) {
        const started = Date.now();
        traceAnalysis(job, 'scanner.prepare', {targetKind: job.executor?.target.kind, targetId: job.executor?.target.id, inputCharacters: text.length});
        try {
            const result = await this.execute(job, text, attached);
            traceAnalysis(job, 'scanner.completed', {candidates: result.candidates.length, tokens: result.tokens, durationMs: Date.now() - started});
            return result;
        }
        catch (error) {
            const count = await this.options.exchanges?.(job).catch(() => undefined);
            throw new TwinDiagnosticError(error instanceof Error && /^TWIN_[A-Z_]+$/.test(error.message) ? error.message : 'TWIN_SCANNER_EXECUTION_FAILED',
                error, error instanceof TwinDiagnosticError && error.tokens !== undefined ? error.tokens : count === 0 ? 0 : undefined);
        }
    }
    private async execute(job: TwinAnalysisJob, text: string, attached: (id: string) => Promise<void>) {
        const kernel = this.options.kernel, calls = this.options.ready().calls;
        const {request, ready} = await this.prepare(job, text);
        const admission = await calls.submitPreparedTaskCall(request);
        try { await attached(admission.submission.task.taskId); }
        catch (error) {
            await (await kernel.attachTask(job.sessionId, admission.submission.task.taskId)).cancel(undefined, {requestId: 'scanner-cancel'});
            throw error;
        }
        traceAnalysis(job, 'scanner.wait', {taskId: admission.submission.task.taskId});
        const caller = await kernel.attachTask(job.sessionId, admission.submission.task.taskId);
        const exit = await caller.wait({until: 'settled', timeoutMs: 150000});
        const result = exit.output as TaskCallResult | undefined;
        if (exit.status !== 'succeeded' || result?.exit.status !== 'succeeded') {
            const cause = result?.exit.error ?? exit.error ?? {message: 'Published scanner execution did not succeed'};
            const code = cause.code && /^TWIN_[A-Z_]+$/.test(cause.code) ? cause.code
                : /^TWIN_[A-Z_]+$/.test(cause.message) ? cause.message : 'TWIN_SCANNER_EXECUTION_FAILED';
            const usage = await this.usage(job, ready.executionSessionId);
            throw new TwinDiagnosticError(code, cause, usage.usageKind === 'reported' ? usage.tokens : undefined);
        }
        return this.acceptResult(job, text, result.exit.output, ready.executionSessionId);
    }
    private async prepare(job: TwinAnalysisJob, text: string) {
        const {repository, bind} = this.options, calls = this.options.ready().calls;
        const executor = job.executor!;
        await repository.ensureSession(job.sessionId, 'Scanner execution');
        const request: IndependentCallInput = {title: 'Scanner result', request: {
            expectedSessionId: job.sessionId, expectedBranch: 'main', expectedTarget: executor.target,
            target: {kind: executor.target.kind, id: executor.target.id, version: executor.target.version}, source: {kind: 'composer', text, attachments: [], values: executor.values ?? {}},
            submission: {id: 'scan', source: {kind: 'conversation', ownerId: job.sessionId, id: 'scan'}},
        }};
        const ready = await calls.prepareTaskCall(request, {maxDepth: 4, timeoutMs: 120000});
        assertScannerPlan(ready.plan.task);
        await bind(job, ready.executionSessionId);
        return {request, ready};
    }
    private async acceptResult(job: TwinAnalysisJob, text: string, output: unknown, sessionId: string) {
        const usage = await this.usage(job, sessionId);
        try {
            const value = scannerOutput(output, job.executor!.outputPath);
            const candidates = parseCandidates(typeof value === 'string' ? value : JSON.stringify(value), text);
            return {candidates, ...usage};
        } catch (error) {
            throw new TwinDiagnosticError('TWIN_INVALID_EXTRACTION', error, usage.usageKind === 'reported' ? usage.tokens : undefined);
        }
    }
    private async usage(job: TwinAnalysisJob, sessionId: string) {
        const tasks = await this.options.kernel.listSessionTasks(sessionId);
        const models = tasks.filter(task => ['llm.agent', 'llm.chat', 'llm.conversation'].includes(task.program.kind));
        const totals = models.map(task => {
            const usage = (task.output as {usage?: {total_tokens?: number; totalTokens?: number}} | undefined)?.usage;
            return usage?.total_tokens ?? usage?.totalTokens;
        });
        const total = totals.reduce<number>((sum, value) => sum + (value ?? NaN), 0);
        const known = Number.isSafeInteger(total) && totals.every(value => Number.isSafeInteger(value) && value! >= 0);
        return {tokens: known ? total : job.reservedTokens, usageKind: known ? 'reported' as const : 'estimated' as const};
    }
    async cancel(job: TwinAnalysisJob): Promise<void> {
        const tasks = await this.options.kernel.listSessionTasks(job.sessionId);
        const caller = job.taskId ? tasks.find(task => task.id === job.taskId) : tasks.find(task => task.program.kind === 'kernel.call');
        if (!caller) throw new Error('TWIN_SCANNER_CANCEL_PENDING');
        const task = await this.options.kernel.attachTask(job.sessionId, caller.id);
        await task.cancel(undefined, {requestId: 'scanner-cancel'});
        await task.wait({until: 'settled', timeoutMs: 150000});
    }
    async cleanup(_job: TwinAnalysisJob): Promise<void> {
        // Keep published-call history and task receipts available for run inspection.
    }
}

/** Inspect executable structure only; input values remain opaque application data. */
export function assertScannerPlan(value: unknown): void {
    const task = value as {program?: {kind?: string}; input?: {initialScheduler?: {spec?: import('@itookit/llm-flow/contracts').DagRunSpec}}};
    if (['kernel-adapters.harness', 'kernel-adapters.media', 'kernel.call'].includes(task.program?.kind ?? '')) throw new Error('TWIN_SCANNER_EXECUTION_UNSUPPORTED');
    if (task.program?.kind === 'flow.aggregate') assertScannerGraph(task.input?.initialScheduler?.spec, 0);
}
function assertScannerGraph(graph: import('@itookit/llm-flow/contracts').DagRunSpec | undefined, depth: number): void {
    if (!graph || depth > 64) throw new Error('TWIN_SCANNER_PLAN_LIMIT');
    for (const node of graph.nodes) {
        const config = node.config as {execution?: {kind?: string}; delegation?: unknown; subtasks?: unknown};
        if (['builtin.spawn', 'builtin.media'].includes(node.plugin)
            || ['builtin.agent', 'builtin.check', 'builtin.revise'].includes(node.plugin) && (config?.execution?.kind === 'harness' || config?.delegation || config?.subtasks))
            throw new Error('TWIN_SCANNER_EXECUTION_UNSUPPORTED');
    }
    for (const template of Object.values(graph.functionCalls ?? {})) assertScannerGraph(template.child, depth + 1);
}
function scannerOutput(value: unknown, path?: string[]): unknown {
    if (path?.length) {
        for (const key of path) {
            if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('TWIN_SCANNER_OUTPUT_INVALID');
            value = (value as Record<string, unknown>)[key];
        }
        return value;
    }
    const output = value as {message?: {content?: unknown}; nodes?: Record<string, {outputs?: {result?: {content?: unknown}}}>};
    return output?.message?.content ?? output?.nodes?.__flow_return?.outputs?.result?.content ?? value;
}
