import {GraphCanvas, type GraphNode, type GraphEdge} from '@itookit/llm-ui/flow';
import type { DagPluginManifest, FlowDraft, FlowNodeId, FlowNodeDefinition } from '@itookit/llm-flow/contracts';
import { escapeHTML } from '@itookit/common';

export interface DagCanvasOptions {
    onSelectNode: (nodeId: FlowNodeId) => void;
    onSelectEdge?: (edgeId: string) => void;
    onSelectCanvas?: () => void;
    onMoveNode: (nodeId: FlowNodeId, position: { x: number; y: number }) => void;
    onConnect: (from: FlowNodeDefinition, to: FlowNodeDefinition) => void;
    onEditNode?: (nodeId: FlowNodeId) => void;
}

interface ProjectedNode extends GraphNode {definition: FlowNodeDefinition; manifest?: DagPluginManifest}

/** Project Flow policy into the shared renderer; gestures and geometry belong to llm-ui. */
export class DagCanvas {
    private readonly graph: GraphCanvas<ProjectedNode, GraphEdge>;
    private definitions = new Map<string, FlowNodeDefinition>();
    constructor(root: HTMLElement, options: DagCanvasOptions) {
        this.graph = new GraphCanvas(root, {
            onSelectNode: node => options.onSelectNode(node.definition.id),
            onSelectEdge: edge => options.onSelectEdge?.(edge.id),
            onSelectCanvas: options.onSelectCanvas,
            onMoveNode: (node, position) => options.onMoveNode(node.definition.id, position),
            onEditNode: node => options.onEditNode?.(node.definition.id),
            onConnect: (from, to) => {
                const source = this.definitions.get(from.nodeId), target = this.definitions.get(to.nodeId);
                if (source && target) options.onConnect(source, target);
            },
            mountNode: (root, node) => this.mountBadges(root, node),
            minCoordinate: -Infinity,
        });
    }
    render(draft: FlowDraft, selectedId?: FlowNodeId, manifests?: ReadonlyMap<string, DagPluginManifest>, selectedEdgeId?: string): void {
        this.definitions = new Map(draft.nodes.map(node => [String(node.id), node]));
        const nodes = draft.nodes.map(definition => {
            const manifest = manifests?.get(String(definition.id)) ?? manifests?.get(`${definition.plugin}@${definition.pluginVersion}`);
            return {id: String(definition.id), name: definition.name, definition, manifest,
                position: draft.layout.nodes?.[definition.id] ?? {x: 40, y: 40}, description: manifest?.title ?? definition.plugin,
                inputs: [{id: 'input', label: 'Connect input'}], outputs: [{id: 'output', label: 'Connect output'}]};
        });
        const edges = draft.edges.map(edge => ({id: String(edge.id), kind: edge.kind,
            from: {nodeId: String(edge.from), portId: 'output'}, to: {nodeId: String(edge.to), portId: 'input'},
            viaY: edge.output === 'repeat' ? Math.max(...nodes.map(node => node.position.y), 0) + 160 : undefined}));
        this.graph.render({nodes, edges, zoom: draft.layout.viewport?.zoom}, selectedId, selectedEdgeId,
            {move: true, connect: true, disconnect: false});
    }
    private mountBadges(root: HTMLElement, node: ProjectedNode): void {
        root.insertAdjacentHTML('beforeend', nodeBadges(node.definition));
        const summary = document.createElement('small'); summary.className = 'dag-node__ports';
        summary.textContent = `In ${portSummary(node.manifest?.inputs)} · Out ${portSummary(node.manifest?.outputs)}`;
        summary.title = `${node.definition.plugin}@${node.definition.pluginVersion}`; root.append(summary);
    }
    fit(): void {this.graph.fit();}
    setActive(active: boolean): void {this.graph.setActive(active);}
    destroy(): void {this.graph.destroy();}
}

/** Strategy badges for builtin.agent nodes: agent reference, history policy, persist, subtask. */
function nodeBadges(node: FlowNodeDefinition): string {
    if (node.plugin !== 'builtin.agent') return '';
    const config = isRecord(node.config) ? node.config : {};
    const badges: string[] = [];
    if (typeof config.agentId === 'string' && config.agentId) {
        badges.push(`<span class="dag-badge dag-badge--agent" title="引用 Agent">${escapeHTML(config.agentId)}</span>`);
    }
    const history = config.historyPolicy === 'none' || config.historyPolicy === 'upstream'
        ? config.historyPolicy : 'inherit';
    badges.push(`<span class="dag-badge dag-badge--history dag-badge--history-${history}" title="History policy">H:${history}</span>`);
    if (config.systemPromptPolicy === 'replace' || config.systemPromptPolicy === 'none') {
        badges.push(`<span class="dag-badge" title="System Prompt policy">SP:${config.systemPromptPolicy}</span>`);
    }
    if (config.persistOutput === true) {
        badges.push(`<span class="dag-badge dag-badge--persist" title="Persist output">P</span>`);
    }
    if ((isRecord(config.delegation) && config.delegation.enabled === true) || config.subtasks) {
        badges.push(`<span class="dag-badge dag-badge--subtask" title="Subtask fan-out">子任务</span>`);
    }
    return badges.length ? `<div class="dag-node__badges">${badges.join('')}</div>` : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Compact port summary for a node card (name* for "many" cardinality). */
function portSummary(ports: Array<{ name: string; cardinality?: string }> | undefined): string {
    if (!ports?.length) return '—';
    return ports.map(port => `${port.name}${port.cardinality === 'many' ? '*' : ''}`).join(', ');
}
