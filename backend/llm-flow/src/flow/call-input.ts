import type {FlowParameter, FlowRevision, JsonValue} from '../contracts/flow-definition';
import {assertFlowCallSignature, flowCallValues, FlowCallInputError, type FlowCallSource, type FlowInputOrigin, type FlowResolvedInput} from '../contracts/flow-call-input';
import {flowParameterValues} from '../contracts/flow-inputs';
import {validateFlowParameters} from './parameters';

export interface FlowCallInputOptions {
    defaults?: Record<string, JsonValue>;
    expected?: Pick<FlowRevision, 'id' | 'revision' | 'digest'>;
    allowUndeclared?: boolean;
}

/** Resolve all entry surfaces before admission; never read UI state or re-evaluate parameter text. */
export function prepareFlowCallInput(flow: Pick<FlowRevision, 'id' | 'revision' | 'digest' | 'parameters' | 'inputGroups'>,
    source: FlowCallSource, options: FlowCallInputOptions = {}): FlowResolvedInput {
    assertFlowCallSignature(flow, options.expected);
    const {values, origins} = flowCallValues(flow.parameters ?? [], source);
    const defaults = options.defaults && flowCallValues([], {kind: 'arguments', value: options.defaults}).values;
    validateNames(flow.parameters ?? [], {...defaults, ...values}, options.allowUndeclared);
    const inherited = flowParameterValues(flow.parameters, defaults, flow.inputGroups);
    const parameters = flowParameterValues(flow.parameters, values, flow.inputGroups, inherited);
    flowCallValues([], {kind: 'arguments', value: parameters});
    const issues = validateFlowParameters(flow.parameters, parameters, flow.inputGroups);
    if (issues.length) throw new FlowCallInputError(`FLOW_INPUT_${issues[0].code.replaceAll('-', '_').toUpperCase()}`,
        issues.map(issue => issue.message).join('; '), undefined, issues);
    return {version: 1, parameters, origins: inputOrigins(parameters, defaults, origins),
        deferredFields: (flow.parameters ?? []).filter(field => field.onMissing === 'interact').map(field => field.name)};
}

function validateNames(fields: readonly FlowParameter[], values: Record<string, JsonValue>, allow = false): void {
    if (allow) return;
    const names = new Set(fields.map(field => field.name));
    for (const name of Object.keys(values)) if (!names.has(name))
        throw new FlowCallInputError('FLOW_INPUT_UNKNOWN_PARAMETER', `Unknown Flow parameter: ${name}`, name);
}

function inputOrigins(values: Record<string, JsonValue>, defaults: Record<string, JsonValue> | undefined,
    explicit: Record<string, FlowInputOrigin[]>): Record<string, FlowInputOrigin[]> {
    return Object.fromEntries(Object.keys(values).map(name => [name, Object.hasOwn(explicit, name) ? explicit[name]
        : [Object.hasOwn(defaults ?? {}, name) ? 'agent-default' : 'flow-default']]));
}
