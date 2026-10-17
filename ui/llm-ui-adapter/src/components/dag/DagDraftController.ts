import type { FlowDraft, FlowNodeId, DagPluginManifest, FlowEdgeDefinition, FlowEdgeId, FlowNodeDefinition, FlowConnection, FlowParameter, FlowDefaults } from '@itookit/llm-flow/contracts';

export interface DeleteNodeResult {
    nodeId: FlowNodeId;
    incidentEdgeCount: number;
}

export class DagDraftController {
    private draft: FlowDraft;
    private undoStack: FlowDraft[] = [];
    private redoStack: FlowDraft[] = [];

    constructor(draft: FlowDraft) {
        this.draft = clone(draft);
    }

    get value(): FlowDraft {
        return clone(this.draft);
    }

    replace(draft: FlowDraft): void {
        this.draft = clone(draft);
        this.undoStack = [];
        this.redoStack = [];
    }

    addNode(
        descriptor: DagPluginManifest,
        position?: { x: number; y: number },
    ): FlowNodeDefinition {
        const node = createFlowNode(descriptor);
        this.change(draft => {
            draft.nodes.push(node);
            draft.layout.nodes = {
                ...draft.layout.nodes,
                [node.id]: position ?? autoPosition(draft.nodes.length - 1),
            };
        });
        return clone(node);
    }

    updateNode(node: FlowNodeDefinition): void {
        this.change(draft => {
            const index = draft.nodes.findIndex(item => item.id === node.id);
            if (index < 0) throw new Error(`Flow node not found: ${node.id}`);
            draft.nodes[index] = clone(node);
        });
    }

    duplicateNode(nodeId: FlowNodeId): FlowNodeDefinition {
        const source = this.requireNode(nodeId);
        const copy = { ...clone(source), id: uniqueId('node'), name: `${source.name} Copy` };
        this.change(draft => {
            draft.nodes.push(copy);
            const sourcePosition = draft.layout.nodes?.[nodeId] ?? { x: 40, y: 40 };
            draft.layout.nodes = {
                ...draft.layout.nodes,
                [copy.id]: { x: sourcePosition.x + 32, y: sourcePosition.y + 32 },
            };
        });
        return clone(copy);
    }

    deleteNode(nodeId: FlowNodeId): DeleteNodeResult {
        const incident = this.draft.edges.filter(edge => edge.from === nodeId || edge.to === nodeId);
        this.change(draft => {
            draft.nodes = draft.nodes.filter(node => node.id !== nodeId);
            const incidentIds = new Set(incident.map(edge => edge.id));
            draft.edges = draft.edges.filter(edge => !incidentIds.has(edge.id));
            if (draft.layout.nodes) delete draft.layout.nodes[nodeId];
        });
        return { nodeId, incidentEdgeCount: incident.length };
    }

    addEdge(edge: FlowEdgeDefinition): void {
        const error = edgeError(this.draft, edge);
        if (error) throw new Error(error);
        this.change(draft => draft.edges.push(clone(edge)));
    }

    updateEdge(edge: FlowEdgeDefinition): void {
        const withoutCurrent = { ...this.draft, edges: this.draft.edges.filter(item => item.id !== edge.id) };
        const error = edgeError(withoutCurrent, edge);
        if (error) throw new Error(error);
        this.change(draft => {
            const index = draft.edges.findIndex(item => item.id === edge.id);
            if (index < 0) throw new Error(`Flow edge not found: ${edge.id}`);
            draft.edges[index] = clone(edge);
        });
    }

    deleteEdge(edgeId: FlowEdgeId): void {
        this.change(draft => {
            draft.edges = draft.edges.filter(edge => edge.id !== edgeId);
        });
    }

    moveNode(nodeId: FlowNodeId, position: { x: number; y: number }): void {
        this.change(draft => {
            draft.layout.nodes = { ...draft.layout.nodes, [nodeId]: position };
        });
    }

    setZoom(zoom: number): void {
        this.change(draft => {
            const viewport = draft.layout.viewport ?? { x: 0, y: 0, zoom: 1 };
            draft.layout.viewport = { ...viewport, zoom: Math.min(2, Math.max(0.4, zoom)) };
        });
    }

    updateFlowSettings(settings: {
        outputs?: FlowDraft['outputs'];
        connections?: FlowConnection[];
        defaultConnection?: string;
        parameters?: FlowParameter[];
        variables?: FlowDraft['variables'];
        defaults?: FlowDefaults;
        runPolicy?: import('@itookit/llm-flow/contracts').FlowRunPolicy;
    }): void {
        this.change(draft => {
            if (settings.outputs) { if (Object.keys(settings.outputs).length) draft.outputs = clone(settings.outputs); else delete draft.outputs; }
            if (settings.connections) draft.connections = clone(settings.connections);
            if ('defaultConnection' in settings) draft.defaultConnection = settings.defaultConnection;
            if (settings.variables) draft.variables = clone(settings.variables);
            if (settings.parameters) draft.parameters = clone(settings.parameters);
            if (settings.defaults !== undefined) draft.defaults = clone(settings.defaults);
            if (settings.runPolicy !== undefined) draft.runPolicy = clone(settings.runPolicy);
        });
    }

    applyAutoLayout(): void {
        this.change(draft => {
            draft.layout.nodes = Object.fromEntries(
                topologicalOrder(draft).map((id, index) => [id, autoPosition(index)]),
            );
        });
    }

    undo(): boolean {
        const previous = this.undoStack.pop();
        if (!previous) return false;
        this.redoStack.push(clone(this.draft));
        this.draft = previous;
        return true;
    }

    redo(): boolean {
        const next = this.redoStack.pop();
        if (!next) return false;
        this.undoStack.push(clone(this.draft));
        this.draft = next;
        return true;
    }

    private requireNode(nodeId: FlowNodeId): FlowNodeDefinition {
        const node = this.draft.nodes.find(item => item.id === nodeId);
        if (!node) throw new Error(`Flow node not found: ${nodeId}`);
        return node;
    }

    private change(mutate: (draft: FlowDraft) => void): void {
        this.undoStack.push(clone(this.draft));
        this.redoStack = [];
        mutate(this.draft);
    }
}

export function createFlowNode(
    descriptor: DagPluginManifest,
): FlowNodeDefinition {
    return {
        id: uniqueId('node'),
        name: descriptor.title,
        plugin: descriptor.id,
        pluginVersion: descriptor.version,
        config: clone(descriptor.defaultConfig ?? {}) as FlowNodeDefinition['config'],
        inputs: {},
        capabilities: [...(descriptor.requiredCapabilities ?? [])],
    };
}

export function createFlowEdge(
    from: FlowNodeDefinition,
    to: FlowNodeDefinition,
    kind: 'control' | 'data',
    ports?: { output?: string; input?: string },
): FlowEdgeDefinition {
    const edge: FlowEdgeDefinition = { id: uniqueId('edge') as FlowEdgeId, from: from.id, to: to.id, kind };
    if (kind === 'data') {
        if (!ports?.output || !ports.input) {
            throw new Error('Data edges require an output and input port');
        }
        edge.output = ports.output;
        edge.input = ports.input;
    }
    return edge;
}

function edgeError(draft: FlowDraft, edge: FlowEdgeDefinition): string | null {
    if (edge.from === edge.to) return 'Self edges are not allowed';
    const from = draft.nodes.find(node => node.id === edge.from);
    const to = draft.nodes.find(node => node.id === edge.to);
    if (!from || !to) return 'Edge references an unknown node';
    if (draft.edges.some(item => edgeKey(item) === edgeKey(edge))) return 'Duplicate edge is not allowed';
    if (edge.kind === 'data' && (!edge.output || !edge.input)) return 'Data edge ports are required';
    // Back edges (loops) are allowed: the DAG executor re-enters loop nodes up
    // to maxIterations. Only degenerate self-edges are rejected below.
    return null;
}

function topologicalOrder(draft: FlowDraft): FlowNodeId[] {
    const pending = new Set(draft.nodes.map(node => node.id));
    const result: FlowNodeId[] = [];
    while (pending.size) {
        const next = [...pending].filter(id =>
            !draft.edges.some(edge => edge.to === id && pending.has(edge.from)),
        );
        const batch = next.length ? next : [pending.values().next().value as FlowNodeId];
        for (const id of batch) {
            pending.delete(id);
            result.push(id);
        }
    }
    return result;
}

function autoPosition(index: number): { x: number; y: number } {
    return { x: 40 + (index % 4) * 220, y: 40 + Math.floor(index / 4) * 150 };
}

function edgeKey(edge: FlowEdgeDefinition): string {
    return [edge.from, edge.to, edge.kind, edge.output, edge.input].join('|');
}

function uniqueId(prefix: string): string {
    const value = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${value}`;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}
