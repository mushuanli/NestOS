import type { DagNodeContext, JsonValue } from '../contracts';

export function isHarnessAgentConfig(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return (value as { execution?: { kind?: unknown } }).execution?.kind === 'harness';
}

/** Keep the original text messages; unsupported content must fail before remote execution. */
export function harnessAgentTask(context: DagNodeContext, messages: unknown[]) {
    const config = context.config as Record<string, JsonValue>;
    if (!config.harnessConnection || typeof config.harnessConnection !== 'object') throw new Error('Harness connection snapshot is required');
    const snapshot = config.harnessConnection as Record<string, JsonValue>, execution = config.execution as Record<string, JsonValue>;
    if (snapshot.version !== 1 || snapshot.kind !== 'harness' || snapshot.id !== execution.connectionId)
        throw new Error('Harness connection snapshot does not match the execution target');
    if (messages.some(message => !message || typeof message !== 'object' || typeof (message as { content?: unknown }).content !== 'string'))
        throw new Error('Harness execution supports text messages only');
    if ((config.delegation as { enabled?: boolean } | undefined)?.enabled || config.subtasks && typeof config.subtasks === 'object')
        throw new Error('Harness Agents cannot host local delegation');
    return { programKind: 'kernel-adapters.harness', programVersion: '1', input: {
        connection: structuredClone(config.harnessConnection), messages: structuredClone(messages),
        dependencies: context.dependencies, includeDependencyOutputs: config.includeDependencyOutputs !== false,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    } };
}
