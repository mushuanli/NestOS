import { graphEffects } from './graph-decoder';
import type { TaskHandle } from '@itookit/durable-kernel';
import type { DagEdgeDefinition, DagNodeDefinition, DagRunSpec, GraphEffect, GraphPatch, JsonValue } from '../contracts';
import type { EdgeState } from './delegation-runtime';
import type { createRunCatalog } from './run-catalog';
import { graphPatchFingerprint, validateGraphPatch } from './graph-patch';
import { patchIdentityConfig } from './patch-identity';
import { mergeAgentConfig } from './to-dag';
import { resolveNodeConnection } from './connections';
import { withDispatchWorkspace, validateDispatchCapacity } from './structured/limits';
import { validateVariableGraph } from './variables';

type ConnectionScope = NonNullable<DagRunSpec['nodeConnections']>[string];
type BoundNode = Partial<Pick<DagNodeDefinition, 'config' | 'inputs'>>;

/** Mutable graph state belongs to one scheduler; persistence remains its responsibility. */
export interface GraphMutationState {
    spec: DagRunSpec;
    parameters?: Record<string, JsonValue>;
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    plugins: ReturnType<typeof createRunCatalog>;
    maxNodes: number;
    appliedPatches: Map<string, string>;
    nodeDefaults: Map<string, Record<string, unknown>>;
    nodeConnections: Map<string, ConnectionScope>;
    edgeState: Map<string, EdgeState>;
    backEdges: Set<string>;
    skipped: Set<string>;
    dispatchOrder: string[];
    instances: Map<string, TaskHandle[]>;
    workspaceDirectory?: string;
    bindNode?(node: DagNodeDefinition, defaults?: Record<string, unknown>): Promise<BoundNode>;
}

/** Apply graph effects in order without taking ownership of leases or checkpoints. */
export class GraphMutationRuntime {
    constructor(private readonly state: GraphMutationState) {}

    async applyEffects(output: unknown, parentId: string): Promise<void> {
        for (const effect of graphEffects(output)) {
            switch (effect.type) {
                case 'activate-edge': this.activateEdge(String(effect.edgeId)); break;
                case 'disable-edge': this.state.edgeState.set(String(effect.edgeId), 'inactive'); break;
                case 'patch-graph': await this.applyPatch(effect.patch, parentId); break;
                case 'cancel-tasks': await this.cancelObservedTasks(effect, parentId); break;
            }
        }
    }

    private async applyPatch(patch: GraphPatch, parentId: string): Promise<void> {
        const state = this.state;
        const fingerprint = graphPatchFingerprint(patch);
        const previous = state.appliedPatches.get(patch.idempotencyKey);
        if (previous !== undefined) {
            if (previous !== fingerprint) throw new Error(`Graph patch ${patch.idempotencyKey}: idempotency conflict`);
            return;
        }
        state.plugins.addNodes(patch.nodes);
        const additions = validateGraphPatch(patch, state.nodes, state.edges, parentId, state.plugins);
        this.assertCapacity(patch);
        const boundNodes: DagNodeDefinition[] = [];
        for (const node of patch.nodes) boundNodes.push(await this.bindNode(node, parentId));
        this.validateBoundPatch(patch, boundNodes, additions, parentId);
        this.publishPatch(patch, boundNodes, additions, parentId, fingerprint);
    }

    private assertCapacity(patch: GraphPatch): void {
        const { nodes, maxNodes } = this.state;
        if (nodes.length + patch.nodes.length > maxNodes) {
            throw new Error(`Flow node limit exceeded by patch ${patch.idempotencyKey}: ${nodes.length + patch.nodes.length}/${maxNodes}`);
        }
    }

    private async bindNode(node: DagNodeDefinition, parentId: string): Promise<DagNodeDefinition> {
        const state = this.state;
        const defaults = node.plugin === 'builtin.agent' ? state.nodeDefaults.get(parentId) : undefined;
        const bound = state.bindNode
            ? await state.bindNode(structuredClone(node), structuredClone(defaults))
            : defaults ? { config: mergeAgentConfig(defaults, record(node.config) as never) } : undefined;
        const config = bound?.config === undefined ? node.config
            : patchIdentityConfig(node.config, bound.config, node.capabilities ?? []);
        const resolvedConfig = structuredClone(config);
        const connection = state.nodeConnections.get(parentId);
        if (connection) resolveNodeConnection(resolvedConfig as JsonValue,
            connection.connections, connection.defaultConnection, connection.fallbackConnectionId, connection.runConnectionId);
        return withDispatchWorkspace({ ...node, config: resolvedConfig, inputs: bound?.inputs ?? node.inputs }, state.workspaceDirectory);
    }

    private validateBoundPatch(patch: GraphPatch, boundNodes: DagNodeDefinition[], additions: DagEdgeDefinition[], parentId: string): void {
        const state = this.state;
        state.plugins.addNodes(boundNodes);
        validateGraphPatch({ ...patch, nodes: boundNodes }, state.nodes, state.edges, parentId, state.plugins);
        const spec = { ...state.spec, nodes: [...state.nodes, ...boundNodes], edges: [...state.edges, ...additions] };
        validateDispatchCapacity(spec, state.parameters);
        validateVariableGraph(spec);
    }

    private publishPatch(patch: GraphPatch, nodes: DagNodeDefinition[], edges: DagEdgeDefinition[], parentId: string, fingerprint: string): void {
        const state = this.state;
        state.nodes.push(...nodes);
        const defaults = state.nodeDefaults.get(parentId);
        if (defaults) for (const node of nodes) state.nodeDefaults.set(node.id, defaults);
        const connection = state.nodeConnections.get(parentId);
        if (connection) for (const node of nodes) state.nodeConnections.set(node.id, connection);
        state.edges.push(...edges);
        for (const edge of edges) state.edgeState.set(edge.id, 'active');
        state.appliedPatches.set(patch.idempotencyKey, fingerprint);
    }

    private activateEdge(edgeId: string): void {
        const state = this.state;
        state.edgeState.set(edgeId, 'active');
        const activated = state.edges.find(edge => edge.id === edgeId);
        if (!activated) return;
        state.skipped.delete(activated.to);
        // Ordinary loop exits must not re-arm the loop head through dispatch order.
        if (state.edges.some(edge => state.backEdges.has(edge.id) && edge.from === activated.to)) {
            state.dispatchOrder.push(activated.to);
        }
    }

    private async cancelObservedTasks(effect: Extract<GraphEffect, { type: 'cancel-tasks' }>, parentId: string): Promise<void> {
        const state = this.state;
        const owner = state.nodes.find(node => node.id === parentId);
        if (owner?.plugin !== 'builtin.join') throw new Error('Only join nodes may cancel observed tasks');
        for (const target of effect.tasks) {
            if (!state.edges.some(edge => edge.from === target.nodeId && edge.to === parentId)) {
                throw new Error('Join cancellation target is not a dependency');
            }
            const handle = state.instances.get(target.nodeId)?.find(item => item.id === target.taskId);
            if (handle) await handle.cancel(effect.reason);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, JsonValue> {
    return isRecord(value) ? value as Record<string, JsonValue> : {};
}
