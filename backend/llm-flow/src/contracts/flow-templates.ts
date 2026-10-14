/** Runtime references are evaluated once against a persisted invocation snapshot. */
export interface FlowTemplateContext {
    vars?: Record<string, unknown>;
    output?: unknown;
    param?: Record<string, unknown>;
    nodes?: Record<string, unknown>;
    state?: Record<string, unknown>;
    iteration?: { round: number };
}
const referencePattern = /\$\{(param|params|nodes|state|iteration|vars|output)\.([A-Za-z0-9_./-]+)\}|\$\{(output)\}/g;

export function flowTemplateReferences(value: unknown): Array<{ root: string; path: string[] }> {
    if (typeof value === 'string') return [...value.matchAll(referencePattern)].map(match => ({ root: match[1] === 'params' ? 'param' : match[1] ?? match[3], path: match[2]?.split('.') ?? [] }));
    if (Array.isArray(value)) return value.flatMap(flowTemplateReferences);
    if (value && typeof value === 'object') {
        const expression = value as { kind?: string; path?: string[] };
        if (expression.kind === 'path' && Array.isArray(expression.path) && ['inputs', 'nodes', 'vars'].includes(expression.path[0])) {
            return [{ root: expression.path[0] === 'inputs' ? 'param' : expression.path[0], path: expression.path.slice(1) }];
        }
        return Object.values(value).flatMap(flowTemplateReferences);
    }
    return [];
}

export function renderFlowTemplate(value: unknown, context: FlowTemplateContext): unknown {
    if (typeof value === 'string') {
        const matches = [...value.matchAll(referencePattern)];
        if (matches.length === 1 && matches[0][0] === value.trim()) return structuredClone(readReference(matches[0], context));
        return value.replace(referencePattern, (...args: string[]) => {
            const resolved = readReference(args, context);
            return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
        });
    }
    if (Array.isArray(value)) return value.map(item => renderFlowTemplate(item, context));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderFlowTemplate(item, context)]));
    return value;
}

function readReference(match: ArrayLike<string>, context: FlowTemplateContext): unknown {
    const root = match[1] === 'params' ? 'param' : match[1] ?? match[3];
    let value: unknown = context[root as keyof FlowTemplateContext];
    const parts = match[2]?.split('.') ?? [];
    if (parts.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error(`Unsafe Flow reference: ${match[0]}`);
    if (root === 'param' && value && typeof value === 'object' && Object.hasOwn(value, match[2])) return (value as Record<string, unknown>)[match[2]];
    for (const key of parts) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsafe Flow reference: ${match[0]}`);
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Missing Flow reference: ${match[0]}`);
        value = (value as Record<string, unknown>)[key];
    }
    if (value === undefined) throw new Error(`Missing Flow reference: ${match[0]}`);
    return value;
}

/** Rename compiler-owned node identities without touching user data at runtime. */
export function remapFlowNodeReferences(value: unknown, aliases: Record<string, string>): unknown {
    if (typeof value === 'string') return value.replace(/\$\{nodes\.([A-Za-z0-9_/-]+)\.outputs\./g,
        (match, id: string) => aliases[id] ? `\${nodes.${aliases[id]}.outputs.` : match);
    if (Array.isArray(value)) return value.map(item => remapFlowNodeReferences(item, aliases));
    if (value && typeof value === 'object') {
        const expression = value as { kind?: string; path?: string[] };
        if (expression.kind === 'path' && expression.path?.[0] === 'nodes' && aliases[expression.path[1]]) return { ...value, path: ['nodes', aliases[expression.path[1]], ...expression.path.slice(2)] };
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapFlowNodeReferences(item, aliases)]));
    }
    return value;
}

export function renderFlowText(template: string, context: FlowTemplateContext): string {
    const value = renderFlowTemplate(template, context);
    return typeof value === 'string' ? value : JSON.stringify(value);
}
