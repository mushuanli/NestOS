import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';
import type { ExecutorConfig, TaskInput } from '../core/types';

export const CLIENT_WEB_SEARCH_TOOL = 'WebSearch';

/** Missing mode preserves legacy callers; new UI sends always include a mode. */
export function directExecutionMode(input: Pick<TaskInput, 'sendIntent' | 'overrides'>): ChatExecutionMode | undefined {
    const execution = input.sendIntent?.execution;
    if (execution?.kind === 'flow') return undefined;
    const mode = execution?.mode ?? input.overrides?.executionMode;
    if (mode !== undefined && mode !== 'chat' && mode !== 'agent') throw new Error('Invalid chat execution mode');
    return mode;
}

export function directToolIds(config: ExecutorConfig, input: Pick<TaskInput, 'sendIntent' | 'overrides'>): string[] {
    const tools = config.capabilityPolicy?.toolIds ?? [];
    if (directExecutionMode(input) !== 'chat') return tools;
    return config.webSearchMode === 'client-tool' ? tools.filter(id => id === CLIENT_WEB_SEARCH_TOOL) : [];
}

/** Detach mutable settings before asynchronous admission or configuration resolution. */
export function snapshotTaskInput(input: TaskInput): TaskInput {
    directExecutionMode(input);
    const copy = { ...input,
        overrides: input.overrides ? structuredClone(input.overrides) : undefined,
        sendIntent: input.sendIntent ? structuredClone(input.sendIntent) : undefined,
    };
    if (copy.sendIntent?.execution.kind === 'agent') copy.sendIntent.execution.mode = directExecutionMode(copy);
    return copy;
}
