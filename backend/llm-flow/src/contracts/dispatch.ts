import type { FlowNodeDefinition, JsonValue, SerializableExpression } from './flow-definition';

/** Invocation context is explicit; no ambient Session or parent history is imported. */
export interface DispatchContextPolicy {
    history: 'none' | 'explicit';
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export type FlowCondition = { all: FlowCondition[] } | { any: FlowCondition[] }
    | { value: JsonValue; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; expected: JsonValue };

export interface FlowOutputContract {
    onInvalid?: 'fail' | 'repair';
    retries?: number;
    format: 'value' | 'json';
    schema?: JsonValue;
    select?: SerializableExpression;
    validate?: SerializableExpression;
}

export interface FlowInvocationDefaults {
    connectionId?: string;
    model?: string;
    prompt?: string;
    context?: DispatchContextPolicy;
    outputContract?: FlowOutputContract;
}

export interface FlowJoinConfig {
    failure: 'fail' | 'partial';
    reducer: string;
    projection?: SerializableExpression;
}

export interface DispatchBranch {
    assign?: Record<string, JsonValue>;
    prompt?: string;
    outputContract?: FlowOutputContract;
    key: string;
    target: FlowNodeDefinition;
    when?: SerializableExpression;
    input: Record<string, SerializableExpression>;
    instruction?: string;
    context?: DispatchContextPolicy;
    publishToHistory?: boolean;
    output?: SerializableExpression;
    outputFormat?: 'value' | 'json';
    outputSchema?: JsonValue;
    /** Additional semantic constraints, evaluated against { value }. */
    validate?: SerializableExpression;
}

/** A durable, structured route/spawn/join scope, usable as an ordinary DAG node. */
/** Durable visibility for graph nodes compiled into a dispatch scope. */
export interface FlowLogicEvent {
    nodeId: string;
    name: string;
    phase: 'aggregate' | 'judge';
    round: number;
    result: unknown;
}

export interface DispatchConfig {
    logicNodes?: { aggregate: { id: string; name: string }; judge: { id: string; name: string } };
    variables?: import('./flow-definition').FlowVariables;
    variableValues?: Record<string, JsonValue>;
    initialParameters?: Record<string, JsonValue>;
    referenceNodes?: Record<string, unknown>;
    invocationDefaults?: FlowInvocationDefaults;
    join?: FlowJoinConfig;
    branches: DispatchBranch[];
    mode: 'exclusive' | 'multicast';
    selectionOrder?: 'missing-first' | 'declared';
    maxRounds: number;
    maxConcurrency?: number;
    context: DispatchContextPolicy;
    /** An invocation override may not relax this constraint. */
    requireNoHistory?: boolean;
    publishToHistory?: boolean;
    until: SerializableExpression;
    initialResults?: Record<string, JsonValue>;
    /** Optional explicit input revision; changed inputs must not reuse old results. */
    inputRevision?: string;
    /** Update inputs between batches via an isolated Task or an explicit human response. */
    revision?: { fields: Record<string, FlowInputField>; prompt: string; invocation?: DispatchBranch };
}

export interface FlowInputField {
    widget?: 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
    options?: JsonValue[];
    minimum?: number;
    maximum?: number;
    type: 'string' | 'number' | 'boolean' | 'json';
    label?: string;
    required?: boolean;
    nonBlank?: boolean;
    default?: JsonValue;
}

export interface FlowInputConfig {
    param?: Record<string, FlowInputField>;
    fields?: Record<string, FlowInputField>;
    prompt?: string;
    initial?: Record<string, JsonValue>;
}
