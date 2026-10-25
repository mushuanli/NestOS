import type {FlowParameter, FlowRevision, JsonValue} from './flow-definition';

/** Attachments have already been converted to the declared content/reference shape by the host. */
export type FlowCallSource = {kind: 'arguments'; value: JsonValue} | {
    kind: 'composer'; text: string; attachments: JsonValue[]; values: Record<string, JsonValue>;
};
export type FlowInputOrigin = 'flow-default' | 'agent-default' | 'arguments' | 'form' | 'composer.text' | 'composer.attachments';
export interface FlowResolvedInput {
    version: 1;
    parameters: Record<string, JsonValue>;
    origins: Record<string, FlowInputOrigin[]>;
    deferredFields: string[];
}

export class FlowCallInputError extends Error {
    constructor(readonly code: string, message: string, readonly field?: string,
        readonly issues?: readonly {code: string; message: string}[]) {super(message); this.name = 'FlowCallInputError';}
}

export function assertFlowCallSource(value: unknown): asserts value is FlowCallSource {
    if (!value || typeof value !== 'object') throw new FlowCallInputError('FLOW_INPUT_SOURCE_INVALID', 'Flow input source is required');
    const source = value as FlowCallSource;
    const fields = source.kind === 'arguments' ? ['kind', 'value'] : ['kind', 'text', 'attachments', 'values'];
    if (Object.keys(source).some(key => !fields.includes(key))) throw new FlowCallInputError('FLOW_INPUT_SOURCE_INVALID', 'Unknown input source field');
    if (source.kind === 'arguments') {inputObject(source.value); return;}
    if (source.kind !== 'composer' || typeof source.text !== 'string' || !Array.isArray(source.attachments) || !jsonValue(source.attachments))
        throw new FlowCallInputError('FLOW_INPUT_SOURCE_INVALID', 'Invalid composer input');
    inputObject(source.values);
}

export function assertFlowCallSignature(flow: {id: string; revision?: number; digest?: string},
    expected?: Pick<FlowRevision, 'id' | 'revision' | 'digest'>): void {
    if (expected && (expected.id !== flow.id || expected.revision !== flow.revision || expected.digest !== flow.digest))
        throw new FlowCallInputError('FLOW_INPUT_SIGNATURE_CHANGED', 'Flow input signature changed; reload before submitting');
}

export function flowCallValues(fields: readonly FlowParameter[], source: FlowCallSource): {
    values: Record<string, JsonValue>; origins: Record<string, FlowInputOrigin[]>;
} {
    assertFlowCallSource(source);
    if (source.kind === 'arguments') {
        const values = source.value as Record<string, JsonValue>;
        return {values: structuredClone(values), origins: Object.fromEntries(Object.keys(values).map(name => [name, ['arguments']]))};
    }
    const values = structuredClone(source.values);
    const origins: Record<string, FlowInputOrigin[]> = Object.fromEntries(Object.keys(values).map(name => [name, ['form']]));
    bindSource(fields, values, origins, 'composer.text', source.text, source.text.length > 0);
    bindSource(fields, values, origins, 'composer.attachments', source.attachments, source.attachments.length > 0);
    return {values, origins};
}

function inputObject(value: unknown): Record<string, JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FlowCallInputError('FLOW_INPUT_OBJECT_REQUIRED', 'Flow arguments must be an object');
    if (!jsonValue(value)) throw new FlowCallInputError('FLOW_INPUT_JSON_REQUIRED', 'Flow arguments must contain only JSON data');
    return value as Record<string, JsonValue>;
}

function bindSource(fields: readonly FlowParameter[], values: Record<string, JsonValue>, origins: Record<string, FlowInputOrigin[]>,
    source: NonNullable<FlowParameter['inputSource']>, value: JsonValue, supplied: boolean): void {
    if (!supplied) return;
    const targets = fields.filter(field => field.inputSource === source);
    if (!targets.length) throw new FlowCallInputError('FLOW_INPUT_UNBOUND', `Input has no declared binding: ${source}`);
    if (source === 'composer.attachments' && targets.length > 1)
        throw new FlowCallInputError('FLOW_INPUT_AMBIGUOUS', 'Attachments require an explicit parameter selection');
    for (const field of targets) {
        if (Object.hasOwn(values, field.name) && !sameValue(values[field.name], value))
            throw new FlowCallInputError('FLOW_INPUT_CONFLICT', `Conflicting input sources for parameter: ${field.name}`, field.name);
        Object.defineProperty(values, field.name, {value: structuredClone(value), enumerable: true, writable: true, configurable: true});
        const previous = Object.hasOwn(origins, field.name) ? origins[field.name] : [];
        Object.defineProperty(origins, field.name, {value: [...previous, source], enumerable: true, configurable: true});
    }
}

function sameValue(a: JsonValue, b: JsonValue): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const left = Object.keys(a).sort(), right = Object.keys(b).sort();
    return left.length === right.length && left.every((key, i) => key === right[i]
        && sameValue((a as Record<string, JsonValue>)[key], (b as Record<string, JsonValue>)[key]));
}

function jsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): value is JsonValue {
    if (typeof value !== 'object' || value === null) return jsonPrimitive(value);
    if (depth > 64 || ancestors.has(value)) return false;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    ancestors.add(value);
    const children = Array.isArray(value) ? [...value] : Object.values(value);
    const valid = children.every(child => jsonValue(child, ancestors, depth + 1));
    ancestors.delete(value); return valid;
}

function jsonPrimitive(value: unknown): boolean {
    if (value === null) return true;
    switch (typeof value) {
        case 'string': case 'boolean': return true;
        case 'number': return Number.isFinite(value);
        default: return false;
    }
}
