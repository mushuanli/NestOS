import type { FlowRevision, FlowDependencyLock } from '../contracts';

/** Resolve transitive dependencies at publication, never again against latest on rerun. */
export async function lockFlowDependencies(flow: Pick<FlowRevision, 'id' | 'nodes' | 'dependencyLocks'>,
    resolve: (id: string, revision?: number) => Promise<FlowRevision | null>, stack: string[] = [],
    budget = { remaining: 1000 }): Promise<Record<string, FlowDependencyLock>> {
    if (stack.length >= 32 || stack.includes(String(flow.id))) throw new Error(`Flow dependency cycle or depth limit: ${[...stack, flow.id].join(' -> ')}`);
    const locks: Record<string, FlowDependencyLock> = {};
    for (const node of flow.nodes.filter(item => item.plugin === 'builtin.flow')) {
        if (--budget.remaining < 0) throw new Error('Too many Flow dependencies');
        const config = node.config as { flowId?: string; revision?: number };
        const previous = flow.dependencyLocks?.[node.id];
        const child = await resolve(config.flowId ?? '', previous?.revision ?? config.revision);
        if (!child) throw new Error(`Flow dependency not found: ${config.flowId}`);
        if (previous && child.digest !== previous.digest) throw new Error(`Flow dependency changed: ${child.id}`);
        const children = await lockFlowDependencies({ ...child, ...(previous ? { dependencyLocks: previous.children } : {}) }, resolve, [...stack, String(flow.id)], budget);
        locks[node.id] = { flowId: String(child.id), revision: child.revision, digest: child.digest, children };
    }
    return locks;
}
