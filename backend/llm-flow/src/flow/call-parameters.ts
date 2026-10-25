import { flowTemplateReferences, type FlowParameter, type JsonValue } from '../contracts';
import { validateFlowParameters } from './parameters';
import type { ValidationIssue } from './validation';

export interface CallParameterIssue extends ValidationIssue { parameter: string }

/** Validate authored bindings without evaluating references or inheriting parent arguments. */
export function validateFlowCallParameters(schema: FlowParameter[] = [], values: Record<string, JsonValue> = {}): CallParameterIssue[] {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [{
        code: 'invalid-call-parameter', parameter: '', message: 'Flow parameters must be an object',
    }];
    const names = new Set(schema.map(field => field.name));
    const issues: CallParameterIssue[] = Object.keys(values).filter(name => !names.has(name)).map(parameter => ({
        code: 'unknown-call-parameter', parameter, message: `Unknown Flow parameter: ${parameter}`,
    }));
    for (const field of schema) {
        const supplied = Object.hasOwn(values, field.name), value = values[field.name];
        if (supplied && wholeReference(value)) continue;
        const dynamic = supplied && flowTemplateReferences(value).length > 0;
        const checked = dynamic ? { ...field, options: undefined, imageConstraints: undefined, fileConstraints: undefined,
            widget: ['images', 'files'].includes(field.widget ?? '') ? undefined : field.widget } : field;
        for (const issue of validateFlowParameters([checked], supplied ? { [field.name]: value } : {})) {
            issues.push({ ...issue, parameter: field.name,
                code: issue.code === 'missing-parameter' ? 'missing-call-parameter' : 'invalid-call-parameter' });
        }
    }
    return issues;
}

function wholeReference(value: JsonValue | undefined): boolean {
    return typeof value === 'string' && /^\$\{(?:params?|input|nodes|state|iteration|vars|output)(?:\.[A-Za-z0-9_./-]+)?\}$/.test(value.trim())
        && flowTemplateReferences(value).length === 1;
}

/** Parameter sets are repeated named calls, with row values overriding shared bindings. */
export function validateFlowCallConfig(schema: FlowParameter[] = [], config: { parameters?: Record<string, JsonValue>; parameterSets?: unknown }): CallParameterIssue[] {
    if (config.parameterSets === undefined) return validateFlowCallParameters(schema, config.parameters);
    const shared = config.parameters ?? {};
    if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return validateFlowCallParameters(schema, shared);
    if (!Array.isArray(config.parameterSets)) {
        if (typeof config.parameterSets === 'string' && wholeReference(config.parameterSets)) {
            return validateFlowCallParameters(schema.map(field => ({ ...field, required: false })), shared);
        }
        return [{ code: 'invalid-call-parameter', parameter: '', message: 'Flow parameterSets must be an object array or whole-value reference' }];
    }
    return config.parameterSets.flatMap((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return [{ code: 'invalid-call-parameter', parameter: '', message: `Flow parameterSets[${index}] must be an object` }];
        return validateFlowCallParameters(schema, { ...shared, ...row }).map(issue => ({ ...issue, message: `parameterSets[${index}]: ${issue.message}` }));
    });
}
