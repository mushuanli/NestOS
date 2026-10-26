import {snapshotTaskCallPlan, type Kernel, type KernelDiagnostic, type TaskCallPlan, type TaskCallResult, type TaskHandle, type TaskSpec} from '@itookit/durable-kernel';
import type {RunExecution, TaskRunDefinition} from './run-submission';

export interface TaskCallRunOptions {
    kernel: Pick<Kernel, 'openSession' | 'bindTaskCall'>;
    caller: {sessionId: string; requestId: string; parent?: string; spawnKey?: string; labels?: Record<string, string>};
    maxDepth: number;
    /** null explicitly allows durable human/child waiting without a total call deadline. */
    timeoutMs?: number | null;
    onDiagnostic?(event: KernelDiagnostic): void;
}
export interface TaskCallRunExecution extends RunExecution {root: TaskHandle<TaskCallResult>}

/** A compiled target is an independent root; the Kernel assigns its durable operation identity. */
export function prepareTaskCall(definition: TaskRunDefinition, policy: Pick<TaskCallRunOptions, 'maxDepth' | 'timeoutMs'>): TaskCallPlan {
    if (definition.kind !== 'task' || definition.task.parent !== undefined || definition.task.spawnKey !== undefined)
        throw invalid('A Task call requires a compiled independent Task root');
    const task = {...definition.task} as TaskSpec;
    // Business invocation labels survive; submission and start identities belong to the owning Effect.
    delete task.requestId; delete task.deferStart;
    return snapshotTaskCallPlan({targetSessionId: definition.sessionId, task, bindings: definition.capabilities,
        maxDepth: policy.maxDepth, ...(policy.timeoutMs !== undefined ? {timeoutMs: policy.timeoutMs} : {})});
}

/** Admission replays the same caller and callee; it never reinterprets a frozen definition. */
export async function submitTaskCall(definition: TaskRunDefinition, options: TaskCallRunOptions): Promise<TaskCallRunExecution> {
    return trace(options, async progress => {
        const kernel = options.kernel, plan = prepareTaskCall(definition, options), spec = callerSpec(options.caller, plan);
        progress.stage = 'caller';
        const session = await kernel.openSession(options.caller.sessionId);
        const root = await session.submit<TaskCallPlan, TaskCallResult>(spec);
        progress.taskId = root.id; progress.stage = 'binding';
        if ((await root.status()).task.status === 'created') await kernel.bindTaskCall({sessionId: session.id, taskId: root.id}, plan);
        return {root, tasks: () => [root]};
    });
}

function callerSpec(caller: TaskCallRunOptions['caller'], plan: TaskCallPlan): TaskSpec<TaskCallPlan> {
    if (!validCaller(caller))
        throw invalid('Task call caller identity is invalid');
    return {program: {kind: 'kernel.call', version: plan.timeoutMs === null ? '2' : '1'}, input: plan, requestId: caller.requestId, deferStart: true,
        ...(caller.parent !== undefined ? {parent: caller.parent} : {}), ...(caller.spawnKey !== undefined ? {spawnKey: caller.spawnKey} : {}),
        ...(caller.labels !== undefined ? {labels: structuredClone(caller.labels)} : {})};
}

function validCaller(caller: TaskCallRunOptions['caller']): boolean {
    return record(caller) && text(caller.sessionId) && text(caller.requestId) && optionalText(caller.parent) && optionalText(caller.spawnKey)
        && validLabels(caller.labels) && Object.keys(caller).every(key => ['sessionId', 'requestId', 'parent', 'spawnKey', 'labels'].includes(key));
}
function optionalText(value: unknown): boolean {return value === undefined || text(value);}
function validLabels(value: unknown): boolean {
    return value === undefined || record(value) && Object.values(value).every(item => typeof item === 'string');
}

async function trace<T>(options: TaskCallRunOptions, operation: (progress: {stage: string; taskId?: string}) => Promise<T>): Promise<T> {
    const started = Date.now(), progress = {stage: 'plan'} as {stage: string; taskId?: string};
    const metadata = {sessionId: safeId(options.caller?.sessionId), operationId: safeId(options.caller?.requestId) ?? 'unidentified-task-call'};
    let outcome: KernelDiagnostic['outcome'] = 'failure', errorCode: string | undefined;
    try {const result = await operation(progress); outcome = 'success'; return result;}
    catch (error) {const code = (error as {code?: unknown})?.code;
        errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'TASK_CALL_SUBMISSION_FAILED'; throw error;}
    finally {
        const event: KernelDiagnostic = {operation: 'run.task.call', stage: progress.stage, outcome, errorCode, durationMs: Date.now() - started,
            ...metadata, taskId: progress.taskId};
        try {if (options.onDiagnostic) options.onDiagnostic(event); else if (outcome === 'failure') console.warn(event.operation, event);}
        catch { /* Diagnostics cannot replace admission or grant execution authority. */ }
    }
}
function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value: unknown): value is string {return typeof value === 'string' && !!value.trim();}
function invalid(message: string): Error {return Object.assign(new Error(message), {code: 'INVALID_SPEC'});}

function safeId(value: unknown): string | undefined {return typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : undefined;}
