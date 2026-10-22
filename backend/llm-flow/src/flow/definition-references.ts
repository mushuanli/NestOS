import type { FlowDependencyLock, FlowDraft, FlowNodeDefinition, FlowRevision } from '../contracts';
import { assertInlineFunctionTree, inlineFunctionScope, resolveInlineFunction, type InlineFunctionScope } from './inline-functions';

type Definition = FlowDraft | FlowRevision;
export interface FlowReference { flowId: string; revision?: number; digest?: string }
export interface FlowCallReference {
    node: FlowNodeDefinition;
    local: boolean;
    lock?: FlowDependencyLock;
}
type Scope = InlineFunctionScope<Definition>;

/** Walk lexical declarations for identity rewriting without turning local names into library IDs. */
export function visitFlowCalls(flow: Definition, visit: (call: FlowCallReference) => void): void {
    assertInlineFunctionTree(flow);
    visitDeclarations(flow, undefined, visit);
}

function visitDeclarations(flow: Definition, parent: Scope | undefined, visit: (call: FlowCallReference) => void): void {
    const scope = inlineFunctionScope(flow, parent, String(flow.id));
    for (const node of flow.nodes) {
        const id = calledFlowId(node);
        if (id) visit({ node, local: !!resolveInlineFunction(scope, id),
            lock: 'dependencyLocks' in flow ? flow.dependencyLocks?.[node.id] : undefined });
    }
    for (const child of flow.functions ?? []) visitDeclarations(child, scope, visit);
}

/** Locks belong to call sites; an equally named transitive dependency cannot replace them. */
export function externalFlowReferences(flow: Definition): FlowReference[] {
    assertInlineFunctionTree(flow);
    return collectReferences(flow, undefined, 'dependencyLocks' in flow ? flow.dependencyLocks : undefined, new Set());
}

function collectReferences(flow: Definition, parent: Scope | undefined, locks: Record<string, FlowDependencyLock> | undefined,
    stack: Set<Definition>, visited = new Set<Definition>()): FlowReference[] {
    if (stack.has(flow) || stack.size > 32) throw new Error('Flow dependency cycle or depth limit');
    const scope = inlineFunctionScope(flow, parent, String(flow.id)), references: FlowReference[] = [];
    visited.add(flow);
    const next = new Set(stack).add(flow);
    for (const node of flow.nodes) {
        const id = calledFlowId(node);
        if (!id) continue;
        const local = resolveInlineFunction(scope, id), lock = locks?.[node.id];
        if (lock && lock.flowId !== id) throw new Error(`Flow dependency lock mismatch: ${node.id}`);
        if (local) {
            references.push(...collectReferences(local.flow, local.scope, lock?.children, next, visited));
        } else {
            const config = node.config as Record<string, unknown>;
            references.push({ flowId: id, revision: lock?.revision ?? (typeof config.revision === 'number' ? config.revision : undefined),
                ...(lock ? { digest: lock.digest } : {}) });
        }
    }
    for (const child of flow.functions ?? []) if (!visited.has(child)) references.push(...collectReferences(child, scope, undefined, next, visited));
    return references;
}

function calledFlowId(node: FlowNodeDefinition): string | undefined {
    const config = node.config;
    return node.plugin === 'builtin.flow' && config && typeof config === 'object' && !Array.isArray(config)
        && typeof config.flowId === 'string' ? config.flowId : undefined;
}
