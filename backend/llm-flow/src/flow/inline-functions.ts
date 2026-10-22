import type { FlowRevision } from '../contracts';

interface InlineDefinition { id: unknown; revision?: number; functions?: InlineDefinition[] }
export interface InlineFunctionScope<T extends InlineDefinition = FlowRevision> {
    parent?: InlineFunctionScope<T>;
    functions: Map<string, { flow: T; scope: InlineFunctionScope<T>; identity: string }>;
}

/** Function declarations belong to their definition environment, including sibling declarations. */
export function inlineFunctionScope<T extends InlineDefinition>(flow: T, parent: InlineFunctionScope<T> | undefined, identity: string): InlineFunctionScope<T> | undefined {
    if (!flow.functions?.length) return parent;
    const scope: InlineFunctionScope<T> = { parent, functions: new Map() };
    for (const fn of flow.functions as T[]) scope.functions.set(String(fn.id), { flow: fn, scope, identity: `${identity}/functions/${fn.id}@${fn.revision}` });
    return scope;
}

export function resolveInlineFunction<T extends InlineDefinition>(scope: InlineFunctionScope<T> | undefined, id: string, revision?: number) {
    while (scope) {
        const found = scope.functions.get(id);
        if (found) {
            if (revision !== undefined && revision !== found.flow.revision) throw new Error(`Inline Flow revision mismatch: ${id}@${revision}`);
            return found;
        }
        scope = scope.parent;
    }
}

/** Bound authored declaration trees independently from the later call-graph traversal. */
export function assertInlineFunctionTree(flow: { id: unknown; functions?: unknown }, depth = 0, budget = { remaining: 1000 }, seen = new Set<object>()): void {
    if (depth > 32 || --budget.remaining < 0) throw new Error('Inline Flow declaration limit exceeded');
    if (seen.has(flow)) throw new Error('Inline Flow declaration cycle');
    seen.add(flow);
    if (flow.functions !== undefined && !Array.isArray(flow.functions)) throw new Error('Flow functions must be an array');
    const ids = new Set<string>();
    for (const fn of flow.functions ?? []) {
        if (!fn || typeof fn !== 'object' || typeof fn.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fn.id) || fn.id.includes('..')) throw new Error('Inline Flow requires a safe id');
        if (!Array.isArray(fn.nodes) || !Array.isArray(fn.edges)) throw new Error(`Inline Flow requires nodes and edges: ${fn.id}`);
        if (ids.has(fn.id)) throw new Error(`Duplicate inline Flow: ${fn.id}`);
        ids.add(fn.id);
        assertInlineFunctionTree(fn, depth + 1, budget, seen);
    }
    seen.delete(flow);
}
