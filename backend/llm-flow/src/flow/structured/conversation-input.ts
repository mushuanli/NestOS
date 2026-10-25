import type { JsonValue } from '../../contracts';
import { json, object } from './value';

/** These Programs consume assembled messages rather than arbitrary function arguments. */
export function isConversationProgram(kind: string): boolean {
    return ['llm.agent', 'llm.chat', 'kernel-adapters.harness'].includes(kind);
}

export function isolatedConversationInput(input: unknown): JsonValue {
    const value = { ...object(input) };
    for (const key of ['messages', 'memoryPolicy', 'sessionContext']) delete value[key];
    value.dependencyBindings = [];
    value.includeDependencyOutputs = false;
    return json(value) as JsonValue;
}
