import type { FlowRevision, FlowDependencyLock, JsonValue } from '../contracts';
import { flowRevisionDigest } from './validation';
import { assertInlineFunctionTree, inlineFunctionScope, resolveInlineFunction, type InlineFunctionScope } from './inline-functions';
import { validateFlowCallConfig } from './call-parameters';

/** Resolve transitive dependencies at publication, never again against latest on rerun. */
export async function lockFlowDependencies(flow: Pick<FlowRevision, 'id' | 'nodes' | 'dependencyLocks' | 'functions'>,
    resolve: (id: string, revision?: number) => Promise<FlowRevision | null>, stack: string[] = [],
    budget = { remaining: 1000 }, parentScope?: InlineFunctionScope, identity = String(flow.id)): Promise<Record<string, FlowDependencyLock>> {
    assertInlineFunctionTree(flow);
    const scope = inlineFunctionScope(flow as FlowRevision, parentScope, identity);
    if (stack.length > 32 || stack.includes(identity)) throw new Error(`Flow dependency cycle or depth limit: ${[...stack, flow.id].join(' -> ')}`);
    const locks: Record<string, FlowDependencyLock> = {};
    for (const node of flow.nodes.filter(item => item.plugin === 'builtin.flow')) {
        if (--budget.remaining < 0) throw new Error('Too many Flow dependencies');
        const config = node.config as { flowId?: string; revision?: number; parameters?: Record<string, JsonValue>; parameterSets?: unknown };
        const previous = flow.dependencyLocks?.[node.id];
        const local = resolveInlineFunction(scope, config.flowId ?? '', previous?.revision ?? config.revision);
        if (local && local.flow.digest !== flowRevisionDigest(local.flow)) throw new Error(`Inline Flow digest mismatch: ${config.flowId}`);
        const child = local?.flow ?? await resolve(config.flowId ?? '', previous?.revision ?? config.revision);
        if (!child) throw new Error(`Flow dependency not found: ${config.flowId}`);
        if (previous && child.digest !== previous.digest) throw new Error(`Flow dependency changed: ${child.id}`);
        const children = await lockFlowDependencies({ ...child, ...(previous ? { dependencyLocks: previous.children } : {}) }, resolve, [...stack, identity], budget, local?.scope, local?.identity ?? `external:${child.id}@${child.revision}`);
        if (node.pluginVersion === '2.0.0') {
            const issues = validateFlowCallConfig(child.parameters, config);
            if (issues.length) throw new Error(`Flow call ${node.id}: ${issues.map(issue => issue.message).join('; ')}`);
        }
        locks[node.id] = { flowId: String(child.id), revision: child.revision, digest: child.digest, children };
    }
    return locks;
}
