import type {FlowConnection, FlowInputGroup, FlowParameter, JsonValue, SerializableExpression} from './flow-definition';
import {resolveFlowExpression} from './flow-expressions';

export interface FlowInputIssue {code: string; message: string}

/** Conditions use only declared parameters, never node results or composer field names. */
export function flowConnectionRequired(slot: FlowConnection, values: Record<string, JsonValue> = {}): boolean {
    return slot.requiredWhen ? Boolean(resolveFlowExpression(slot.requiredWhen, {}, values)) : slot.required !== false;
}

export function flowParameterValues(schema: FlowParameter[] | undefined, values?: Record<string, JsonValue>, groups?: FlowInputGroup[], inherited?: Record<string, JsonValue>): Record<string, JsonValue> {
    const defaults = Object.fromEntries((schema ?? []).filter(param => param.default !== undefined).map(param => [param.name, param.default!]));
    return structuredClone(mergeParameterLayer(mergeParameterLayer(defaults, inherited, groups), values, groups));
}

function mergeParameterLayer(base: Record<string, JsonValue>, values: Record<string, JsonValue> = {}, groups: FlowInputGroup[] = []): Record<string, JsonValue> {
    const defaults = {...base};
    for (const group of groups ?? []) {
        if (!group.parameters.some(name => Object.hasOwn(values ?? {}, name) && flowInputPresent(values?.[name]))) continue;
        for (const name of group.parameters) if (!Object.hasOwn(values ?? {}, name)) delete defaults[name];
    }
    return {...defaults, ...values};
}

/** Run preparation may defer an entirely missing group to its explicit input collectors. */
export function validateFlowInputGroups(schema: FlowParameter[] | undefined, groups: FlowInputGroup[] | undefined,
    values: Record<string, JsonValue> = {}, options: {allowInteractiveMissing?: boolean} = {}): FlowInputIssue[] {
    const issues: FlowInputIssue[] = [];
    for (const group of groups ?? []) {
        const count = group.parameters.filter(name => Object.hasOwn(values, name) && flowInputPresent(values[name])).length;
        const interactive = options.allowInteractiveMissing && group.parameters.every(name => schema?.find(field => field.name === name)?.onMissing === 'interact');
        if (count === 1 || count === 0 && interactive) continue;
        issues.push({code: count ? 'conflicting-input-group' : 'missing-input-group', message: `Input group ${group.name} requires exactly one value`});
    }
    return issues;
}

export function flowInputDeclarationIssues(flow: {parameters?: FlowParameter[]; inputGroups?: FlowInputGroup[]; connections?: FlowConnection[]}): FlowInputIssue[] {
    const issues: FlowInputIssue[] = [], names = new Set((flow.parameters ?? []).map(field => field.name)), seen = new Set<string>();
    for (const parameter of flow.parameters ?? []) {
        if (parameter.inputSource !== undefined && (parameter.inputSource !== 'composer.text' && parameter.inputSource !== 'composer.attachments'
            || parameter.inputSource === 'composer.text' && parameter.type !== 'string'
            || parameter.inputSource === 'composer.attachments' && (parameter.type !== 'json' || !['images', 'files'].includes(parameter.widget ?? '')))) {
            issues.push({code: 'invalid-input-source', message: `Invalid input source declaration: ${parameter.name}`});
        }
    }
    for (const group of flow.inputGroups ?? []) {
        if (!validGroup(group, names, seen)) issues.push({code: 'invalid-input-group', message: 'Invalid Flow input group declaration'});
    }
    for (const connection of flow.connections ?? []) {
        if (connection.requiredWhen !== undefined && !validCondition(connection.requiredWhen, names)) {
            issues.push({code: 'invalid-connection-condition', message: `Invalid connection requirement condition: ${connection.name}`});
        }
    }
    return issues;
}

function validGroup(group: FlowInputGroup, names: Set<string>, seen: Set<string>): boolean {
    if (!group || typeof group.name !== 'string' || !group.name.trim() || group.mode !== 'oneOf' || !Array.isArray(group.parameters)
        || group.parameters.length < 2 || new Set(group.parameters).size !== group.parameters.length || seen.has('group:' + group.name)) return false;
    seen.add('group:' + group.name);
    for (const name of group.parameters) {
        if (!names.has(name) || seen.has('field:' + name)) return false;
        seen.add('field:' + name);
    }
    return true;
}

function validCondition(value: SerializableExpression, parameters: Set<string>, depth = 0): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 32) return false;
    if (value.kind === 'literal') return Object.hasOwn(value, 'value');
    if (value.kind === 'param') return Array.isArray(value.path) && value.path.length > 0
        && value.path.every(part => typeof part === 'string') && parameters.has(value.path[0]!);
    const count = value.kind === 'and' || value.kind === 'or' ? -1 : value.kind === 'not' || value.kind === 'exists' || value.kind === 'in' ? 1
        : ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(value.kind) ? 2 : 0;
    if (!count || !Array.isArray(value.args) || (count < 0 ? !value.args.length : value.args.length !== count)) return false;
    return (value.kind !== 'in' || Array.isArray(value.value)) && value.args.every(item => validCondition(item, parameters, depth + 1));
}

export function flowInputPresent(value: JsonValue | undefined): boolean {
    return value !== undefined && value !== null && (typeof value !== 'string' || !!value.trim()) && (!Array.isArray(value) || value.length > 0);
}
