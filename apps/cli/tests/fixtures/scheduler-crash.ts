import { Kernel } from '@itookit/durable-kernel';

// Inject only at public host boundaries; the killed process never rewrites durable state.
const submit = Kernel.prototype.submit;
Kernel.prototype.submit = async function<I, O>(sessionId: string, spec: import('@itookit/durable-kernel').TaskSpec<I>, options?: import('@itookit/durable-kernel').LeaseGuardOptions) {
    const handle = await submit.call(this, sessionId, spec, options);
    const target = process.env.MINDOS_TEST_SUBMIT_NODE;
    if (target && (spec.labels?.flowNodeId === target || (target === 'root-created' && spec.labels?.kind === 'flow-root'))) process.kill(process.pid, 'SIGKILL');
    return handle as import('@itookit/durable-kernel').TaskHandle<O>;
};

const setShared = Kernel.prototype.setShared;
Kernel.prototype.setShared = async function<T extends import('@itookit/durable-kernel').JsonValue>(sessionId: string,
    key: string, value: T, options?: import('@itookit/durable-kernel').SharedStateWriteOptions) {
    const target = process.env.MINDOS_TEST_COMPLETED_INSTANCE;
    const envelope = value as { version?: number; state?: { completed?: string[] }; frozenKey?: string; completed?: string[]; appliedPatches?: unknown[] } | null;
    const completed = (envelope?.version === 2 ? envelope.state : envelope)?.completed;
    const frozen = envelope?.version === 2 && envelope.frozenKey
        ? (await this.getShared(sessionId, envelope.frozenKey))?.value as { value?: { appliedPatches?: unknown[] } } | undefined : undefined;
    const appliedPatches = envelope?.version === 2 ? frozen?.value?.appliedPatches : envelope?.appliedPatches;
    if (process.env.MINDOS_TEST_SUBMIT_NODE === 'graph-patched' && key.endsWith('.scheduler')
        && appliedPatches?.length) process.kill(process.pid, 'SIGKILL');
    if (target && key.endsWith('.scheduler') && completed?.includes(target)) process.kill(process.pid, 'SIGKILL');
    return setShared.call(this, sessionId, key, value, options) as Promise<import('@itookit/durable-kernel').SharedStateEntry<T>>;
};

const createResource = Kernel.prototype.createResource;
Kernel.prototype.createResource = async function(sessionId, spec, options) {
    const grant = await createResource.call(this, sessionId, spec, options);
    if (process.env.MINDOS_TEST_SUBMIT_NODE === 'capability-bound' && spec.kind === 'llm') process.kill(process.pid, 'SIGKILL');
    return grant;
};

const startTask = Kernel.prototype.startTask;
Kernel.prototype.startTask = async function(sessionId, taskId, options) {
    await startTask.call(this, sessionId, taskId, options);
    if (process.env.MINDOS_TEST_SUBMIT_NODE === 'task-started') process.kill(process.pid, 'SIGKILL');
};

const signal = Kernel.prototype.signal;
Kernel.prototype.signal = async function(sessionId, taskId, value, options) {
    if (process.env.MINDOS_TEST_SUBMIT_NODE === 'delegation-joined' && value.type === 'flow.schedule.completed') {
        process.kill(process.pid, 'SIGKILL');
    }
    return signal.call(this, sessionId, taskId, value, options);
};

await import('../../src/cli');
