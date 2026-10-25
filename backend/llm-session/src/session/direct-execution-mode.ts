import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';
import type { ExecutorConfig, TaskInput } from '../core/types';
import {isInvocationIdentity} from '@itookit/llm-flow/contracts';

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
    if (input.invocation !== undefined && !isInvocationIdentity(input.invocation))
        throw Object.assign(new Error('Invalid invocation identity'), {code: 'INVOCATION_IDENTITY_INVALID'});
    const copy = { ...input,
        target: input.target ? structuredClone(input.target) : undefined,
        expectedTarget: input.expectedTarget ? structuredClone(input.expectedTarget) : undefined,
        source: input.source ? structuredClone(input.source) : undefined,
        invocation: input.invocation ? structuredClone(input.invocation) : undefined,
        overrides: input.overrides ? structuredClone(input.overrides) : undefined,
        sendIntent: input.sendIntent ? structuredClone(input.sendIntent) : undefined,
        instructionFlowBinding: input.instructionFlowBinding ? structuredClone(input.instructionFlowBinding) : undefined,
        instructionConnectionBinding: input.instructionConnectionBinding ? structuredClone(input.instructionConnectionBinding) : undefined,
    };
    if (copy.sendIntent?.execution.kind === 'agent') copy.sendIntent.execution.mode = directExecutionMode(copy);
    return copy;
}
