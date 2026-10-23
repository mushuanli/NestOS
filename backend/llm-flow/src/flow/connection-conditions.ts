import {flowConnectionRequired, flowParameterValues, flowTemplateReferences, type FlowConnection, type FlowRevision, type JsonValue} from '../contracts';

type Parameters = Record<string, JsonValue>;

/** A callable template must admit every connection any of its rows may need. */
export function resolveConnectionConditions(flow: FlowRevision, supplied: Parameters | undefined, parameterSets?: unknown): FlowConnection[] | undefined {
    return flow.connections?.map(slot => {
        if (!slot.requiredWhen) return slot;
        const {requiredWhen: _condition, ...materialized} = slot;
        return {...materialized, required: requiredForRows(slot, flow, supplied, parameterSets)};
    });
}

function requiredForRows(slot: FlowConnection, flow: FlowRevision, supplied: Parameters | undefined, parameterSets: unknown): boolean {
    if (parameterSets === undefined) return requiredForValues(slot, flow, supplied);
    if (!Array.isArray(parameterSets)) return true;
    return parameterSets.some(row => !record(row) || requiredForValues(slot, flow, {...supplied, ...row}));
}

function requiredForValues(slot: FlowConnection, flow: FlowRevision, supplied?: Parameters): boolean {
    const values = flowParameterValues(flow.parameters, supplied, flow.inputGroups);
    const keys = conditionParameters(slot.requiredWhen);
    if ([...keys].some(name => flowTemplateReferences(values[name]).length > 0)) return true;
    return flowConnectionRequired(slot, values);
}

function conditionParameters(expression: FlowConnection['requiredWhen'], keys = new Set<string>()): Set<string> {
    if (expression?.kind === 'param' && expression.path?.length) keys.add(expression.path[0]);
    for (const argument of expression?.args ?? []) conditionParameters(argument, keys);
    return keys;
}
function record(value: unknown): value is Parameters {return !!value && typeof value === 'object' && !Array.isArray(value);}
