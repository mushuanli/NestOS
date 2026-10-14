import type { DagNodeOutcome } from '../contracts';
import type {
    Decision,
    DurableTaskProgram,
    JsonValue,
    TaskInputEvent,
} from '@itookit/durable-kernel';
import {
    collectDependency,
    dependenciesReady,
    dependencyWait,
} from '@itookit/llm-tasks';
import { aggregateOutcome, reduceOutcome, routeOutcome, spawnOutcome, transformOutcome } from './operations';
import { FlowReducerRegistry, projectSummary } from './structured/join';
import type { FlowJoinConfig } from '../contracts';
import type { ResultSlot } from './structured/types';
import { returnOutcome } from './function-outputs';

export interface FlowDependencyBinding {
    taskId: string;
    input: string;
    output?: string;
    edgeId?: string;
}

export interface FlowValueInput {
    operation: 'transform' | 'reduce' | 'route' | 'spawn' | 'aggregate' | 'taskGroup' | 'loop' | 'return';
    iteration?: number;
    nodeId?: string;
    config: Record<string, JsonValue>;
    inputs: Record<string, JsonValue>;
    dependencies: FlowDependencyBinding[];
    /** Flow runtime parameters — made available to route expressions via `param` kind. */
    parameters?: Record<string, JsonValue>;
}

interface FlowValueState extends FlowValueInput {
    dependencyOutputs: Record<string, JsonValue>;
    resolvedDependencyIds: string[];
}

export class FlowValueProgram implements DurableTaskProgram<FlowValueState, FlowValueInput, DagNodeOutcome> {
    readonly manifest = { kind: 'flow.value', version: '1' };
    constructor(private readonly reducers = new FlowReducerRegistry()) {}

    init(input: FlowValueInput): Decision<FlowValueState, DagNodeOutcome> {
        const state = { ...clone(input), dependencyOutputs: {}, resolvedDependencyIds: [] };
        return input.dependencies.length ? { state, next: dependencyWait(input.dependencies) } : completeValue(state, this.reducers);
    }

    reduce(state: Readonly<FlowValueState>, event: TaskInputEvent): Decision<FlowValueState, DagNodeOutcome> {
        const next = clone(state) as FlowValueState;
        collectDependency(next.dependencies, next.dependencyOutputs, next.resolvedDependencyIds, event, 'result');
        return dependenciesReady(next.dependencies, next.resolvedDependencyIds)
            ? completeValue(next, this.reducers)
            : { state: next, next: dependencyWait(next.dependencies) };
    }
}

export interface FlowHumanInput {
    requestId: string;
    prompt: string;
    schema?: JsonValue;
    dependencies: FlowDependencyBinding[];
}

interface FlowHumanState extends FlowHumanInput {
    phase: 'dependencies' | 'interaction';
    dependencyOutputs: Record<string, JsonValue>;
    resolvedDependencyIds: string[];
}

export class FlowHumanProgram implements DurableTaskProgram<FlowHumanState, FlowHumanInput, DagNodeOutcome> {
    readonly manifest = { kind: 'flow.human', version: '1' };

    init(input: FlowHumanInput): Decision<FlowHumanState, DagNodeOutcome> {
        if (!input.prompt.trim()) throw new Error('Human Flow node requires a prompt');
        const state: FlowHumanState = {
            ...clone(input), phase: input.dependencies.length ? 'dependencies' : 'interaction',
            dependencyOutputs: {}, resolvedDependencyIds: [],
        };
        return input.dependencies.length ? { state, next: dependencyWait(input.dependencies) } : requestHuman(state);
    }

    reduce(state: Readonly<FlowHumanState>, event: TaskInputEvent): Decision<FlowHumanState, DagNodeOutcome> {
        const next = clone(state) as FlowHumanState;
        if (next.phase === 'dependencies') {
            collectDependency(next.dependencies, next.dependencyOutputs, next.resolvedDependencyIds, event, 'result');
            if (!dependenciesReady(next.dependencies, next.resolvedDependencyIds)) {
                return { state: next, next: dependencyWait(next.dependencies) };
            }
            next.phase = 'interaction';
            return requestHuman(next);
        }
        if (event.type !== 'interaction-resolved') return fail(next, `Expected interaction, received ${event.type}`);
        return {
            state: next,
            next: { type: 'complete', output: artifactOutcome('response', event.value) },
        };
    }
}

export interface FlowAggregateInput {
    variables?: JsonValue;
    awaitingSchedule?: boolean;
    dependencies: Array<{ taskId: string; nodeId: string; tolerated?: boolean; collectOutput?: boolean }>;
}

interface FlowAggregateState extends FlowAggregateInput {
    outputs: Record<string, JsonValue>;
    failures: Record<string, JsonValue>;
    resolved: string[];
}

export class FlowAggregateProgram implements DurableTaskProgram<FlowAggregateState, FlowAggregateInput, JsonValue> {
    readonly manifest = { kind: 'flow.aggregate', version: '1' };

    init(input: FlowAggregateInput): Decision<FlowAggregateState, JsonValue> {
        const state = { ...clone(input), outputs: {}, failures: {}, resolved: [] };
        if (input.awaitingSchedule) return { state, next: { type: 'wait', on: { type: 'signal' } } };
        return input.dependencies.length
            ? { state, next: dependencyWait(input.dependencies) }
            : { state, next: { type: 'complete', output: { nodes: {} } } };
    }

    reduce(state: Readonly<FlowAggregateState>, event: TaskInputEvent): Decision<FlowAggregateState, JsonValue> {
        // Older flow.aggregate@1 states predate `failures`/`resolved`; hydrate
        // them so recovery from an existing Task record remains compatible.
        const hydrated = clone(state) as Partial<FlowAggregateState>;
        hydrated.outputs = hydrated.outputs ?? {};
        hydrated.failures = hydrated.failures ?? {};
        hydrated.dependencies = hydrated.dependencies ?? [];
        hydrated.resolved = hydrated.resolved ?? hydrated.dependencies
            .filter(item => item.nodeId in hydrated.outputs!)
            .map(item => item.taskId);
        const next = hydrated as FlowAggregateState;
        if (next.awaitingSchedule) {
            if (event.type === 'signal' && event.signal.type === 'flow.schedule.failed') {
                return { state: next, next: { type: 'fail', error: { message: String(event.signal.payload) } } };
            }
            if (event.type !== 'signal' || event.signal.type !== 'flow.schedule.completed') {
                return { state: next, next: { type: 'wait', on: { type: 'signal' } } };
            }
            next.dependencies = (event.signal.payload as unknown as FlowAggregateInput).dependencies;
            next.variables = (event.signal.payload as unknown as FlowAggregateInput).variables;
            next.awaitingSchedule = false;
        }
        if (event.type === 'task-exited') {
            const dependency = next.dependencies.find(item => item.taskId === event.taskId);
            if (dependency) {
                if (event.exit.status === 'failed' && dependency.tolerated !== true) {
                    const reason = event.exit.error?.message ?? `${event.taskId} exited with failed`;
                    return { state: next, next: { type: 'fail', error: { message: `Flow node ${dependency.nodeId} failed: ${reason}` } } };
                }
                if (!next.resolved.includes(dependency.taskId)) next.resolved.push(dependency.taskId);
                if (dependency.collectOutput !== false) next.outputs[dependency.nodeId] = jsonValue(event.exit.output);
                if (event.exit.status === 'failed') {
                    next.failures[dependency.nodeId] = jsonValue(event.exit.error?.message ?? event.exit.status);
                }
            }
        }
        const ready = next.dependencies.every(item => next.resolved.includes(item.taskId));
        if (!ready) return { state: next, next: dependencyWait(next.dependencies) };
        const output: Record<string, JsonValue> = { nodes: next.outputs, ...(next.variables ? { variables: next.variables } : {}) };
        if (Object.keys(next.failures).length > 0) output.failures = next.failures;
        return { state: next, next: { type: 'complete', output } };
    }
}

function completeValue(state: FlowValueState, reducers: FlowReducerRegistry): Decision<FlowValueState, DagNodeOutcome> {
    if (state.operation === 'return') return { state, next: { type: 'complete', output: returnOutcome(state.config.returns) } };
    const inputs = { ...state.inputs, ...state.dependencyOutputs };
    if (state.operation === 'loop') return { state, next: { type: 'complete', output: artifactOutcome('result', {
        round: state.iteration ?? 1, maxRounds: state.config.maxRounds, lastRound: (state.iteration ?? 1) >= Number(state.config.maxRounds),
    }) } };
    if (state.operation === 'taskGroup') return { state, next: { type: 'complete', output: artifactOutcome('result', (inputs.input ?? null) as JsonValue) } };
    if (state.operation === 'aggregate' && state.config.reducer) return aggregateValue(state, inputs, reducers);
    if (state.operation === 'route') {
        return { state, next: { type: 'complete', output: routeOutcome(state.config, inputs, state.parameters) } };
    }
    const operation = state.operation === 'transform'
        ? transformOutcome
        : state.operation === 'aggregate' ? aggregateOutcome
        : state.operation === 'reduce' ? reduceOutcome
        : spawnOutcome;
    const output = state.operation === 'spawn'
        ? spawnOutcome(state.config, inputs, state.nodeId)
        : operation(state.config, inputs);
    return { state, next: { type: 'complete', output } };
}

function aggregateValue(state: FlowValueState, inputs: Record<string, JsonValue>, reducers: FlowReducerRegistry): Decision<FlowValueState, DagNodeOutcome> {
    const updates = state.config.updates ?? (inputs.input as { results?: JsonValue } | undefined)?.results ?? {};
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('Aggregate updates must be keyed results');
    const policy: FlowJoinConfig = { failure: 'fail', reducer: String(state.config.reducer),
        projection: state.config.projection as unknown as FlowJoinConfig['projection'] };
    const previous = state.config.previous ?? undefined;
    const summary = reducers.reduce(policy, previous, updates as unknown as Record<string, ResultSlot>);
    return { state, next: { type: 'complete', output: artifactOutcome('result', projectSummary(policy, summary)) } };
}

function requestHuman(state: FlowHumanState): Decision<FlowHumanState, DagNodeOutcome> {
    return {
        state,
        actions: [{
            type: 'request-interaction',
            interaction: {
                id: state.requestId,
                kind: 'input',
                prompt: state.prompt,
                payload: state.schema ?? null,
            },
        }],
        next: { type: 'wait', on: { type: 'interaction', id: state.requestId } },
    };
}

function artifactOutcome(name: string, value: JsonValue): DagNodeOutcome {
    return { outputs: { [name]: { outputName: name, type: 'json', content: value } } };
}

function fail<S>(state: S, message: string): Decision<S, DagNodeOutcome> {
    return { state, next: { type: 'fail', error: { message } } };
}

function clone<T>(value: T): T { return structuredClone(value); }
function jsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; }
