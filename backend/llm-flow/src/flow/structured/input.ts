import type { FlowInputConfig, FlowInputField, JsonValue } from '../../contracts';
import type { Decision, DurableTaskProgram, TaskInputEvent } from '@itookit/durable-kernel';
import { collectDependency, dependenciesReady, dependencyWait } from '@itookit/llm-tasks';
import type { FlowDependencyBinding } from '../programs';
import { assertKey, object, outcome } from './value';

export interface InputProgramInput extends FlowInputConfig {
    fields: Record<string, FlowInputField>;
    values: Record<string, JsonValue>;
    dependencies: FlowDependencyBinding[];
}

export interface InputState extends InputProgramInput {
    dependencyOutputs: Record<string, JsonValue>;
    resolvedDependencyIds: string[];
    sequence: number;
    requested: string[];
    phase: 'dependencies' | 'input';
}

export function validateFields(fields: Record<string, FlowInputField> | undefined): void {
    if (!fields || !Object.keys(fields).length) throw new Error('Input fields are required');
    for (const [key, field] of Object.entries(fields)) {
        assertKey(key);
        if (!['string', 'number', 'boolean', 'json'].includes(field.type)) throw new Error(`Invalid input type: ${key}`);
        if (field.widget && !['text', 'textarea', 'number', 'select', 'checkbox'].includes(field.widget)) throw new Error(`Invalid input widget: ${key}`);
        if (field.widget === 'select' && !field.options?.length) throw new Error(`Select requires options: ${key}`);
        if (field.nonBlank && field.type !== 'string') throw new Error(`nonBlank requires string: ${key}`);
    }
}

export function invalidFields(fields: Record<string, FlowInputField>, values: Record<string, JsonValue>): string[] {
    return Object.entries(fields).filter(([key, field]) => {
        const value = values[key];
        if (value === undefined || value === null) return field.required !== false;
        if (field.type !== 'json' && typeof value !== field.type) return true;
        if (field.type === 'number' && (!Number.isFinite(value) || (field.minimum !== undefined && Number(value) < field.minimum) || (field.maximum !== undefined && Number(value) > field.maximum))) return true;
        if (field.options && !field.options.some(option => JSON.stringify(option) === JSON.stringify(value))) return true;
        return field.nonBlank === true && !String(value).trim();
    }).map(([key]) => key);
}

export function mergeInput(fields: Record<string, FlowInputField>, values: Record<string, JsonValue>, patch: unknown, keys: string[]): void {
    const supplied = object(patch);
    for (const key of keys) if (Object.hasOwn(supplied, key) && fields[key]) values[key] = supplied[key] as JsonValue;
}

export class FlowInputProgram implements DurableTaskProgram<InputState, InputProgramInput, unknown> {
    readonly manifest = { kind: 'flow.input', version: '1' };

    init(input: InputProgramInput): Decision<InputState, unknown> {
        input = { ...input, fields: input.param ?? input.fields };
        validateFields(input.fields);
        const defaults = Object.fromEntries(Object.entries(input.fields).filter(([, f]) => f.default !== undefined).map(([k, f]) => [k, f.default!]));
        const supplied = { ...defaults, ...input.initial, ...input.values };
        const values = Object.fromEntries(Object.keys(input.fields).filter(key => supplied[key] !== undefined).map(key => [key, supplied[key]]));
        const state: InputState = { ...structuredClone(input), values,
            phase: 'dependencies', dependencyOutputs: {}, resolvedDependencyIds: [], sequence: 0, requested: [] };
        return advanceInput(state);
    }

    reduce(current: Readonly<InputState>, event: TaskInputEvent): Decision<InputState, unknown> {
        const state = structuredClone(current);
        if (state.phase === 'dependencies') collectDependency(state.dependencies, state.dependencyOutputs, state.resolvedDependencyIds, event, 'result');
        else if (event.type === 'interaction-resolved' && event.interactionId === `input-${state.sequence}`) {
            mergeInput(state.fields, state.values, event.value, state.requested);
        } else return askInput(state, false);
        return advanceInput(state);
    }
}

function advanceInput(state: InputState): Decision<InputState, unknown> {
    if (state.phase === 'dependencies') {
        if (!dependenciesReady(state.dependencies, state.resolvedDependencyIds)) return { state, next: dependencyWait(state.dependencies) };
        for (const [key, value] of Object.entries(state.dependencyOutputs)) {
            if (key === 'input') mergeInput(state.fields, state.values, value, Object.keys(state.fields));
            else if (state.fields[key]) state.values[key] = value;
        }
        state.phase = 'input';
    }
    state.requested = invalidFields(state.fields, state.values);
    if (!state.requested.length) return { state, next: { type: 'complete', output: outcome(state.values) } };
    return askInput(state, true);
}

function askInput(state: InputState, create: boolean): Decision<InputState, unknown> {
    if (create) state.sequence++;
    const id = `input-${state.sequence}`;
    const fields = Object.fromEntries(state.requested.map(key => [key, state.fields[key]]));
    const prompt = [state.prompt ?? 'Please provide the missing or invalid fields:', ...state.requested.map(key => state.fields[key].label ?? key)].join('\n');
    return { state, ...(create ? { actions: [{ type: 'request-interaction' as const,
        interaction: { id, kind: 'input', prompt, payload: { fields, values: state.values } as unknown as JsonValue } }] } : {}),
        next: { type: 'wait', on: { type: 'interaction', id } } };
}
