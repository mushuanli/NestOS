import type { DagNodeContext, JsonValue } from '../contracts';

export function isHarnessAgentConfig(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return (value as { execution?: { kind?: unknown } }).execution?.kind === 'harness';
}

/** Preserve structured messages and asset references for the Program and authorized host preparation. */
export function harnessAgentTask(context: DagNodeContext, messages: unknown[]) {
    const config = context.config as Record<string, JsonValue>;
    if (!config.harnessConnection || typeof config.harnessConnection !== 'object') throw new Error('Harness connection snapshot is required');
    const snapshot = config.harnessConnection as Record<string, JsonValue>, execution = config.execution as Record<string, JsonValue>;
    if (snapshot.version !== 1 || snapshot.kind !== 'harness' || snapshot.id !== execution.connectionId)
        throw new Error('Harness connection snapshot does not match the execution target');
    if (messages.some(message => !validMessage(message))) throw new Error('Harness execution requires text or structured content messages');
    if (hasLocalDelegation(config)) throw new Error('Harness Agents cannot host local delegation');
    return { programKind: 'kernel-adapters.harness', programVersion: '1', input: {
        connection: structuredClone(config.harnessConnection), messages: structuredClone(messages),
        dependencies: context.dependencies, includeDependencyOutputs: config.includeDependencyOutputs !== false,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    } };
}

function hasLocalDelegation(config: Record<string, JsonValue>): boolean {
    return Boolean((config.delegation as {enabled?: boolean} | undefined)?.enabled || config.subtasks && typeof config.subtasks === 'object');
}

function validMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const content = (value as {content?: unknown}).content;
    return typeof content === 'string' || Array.isArray(content);
}
