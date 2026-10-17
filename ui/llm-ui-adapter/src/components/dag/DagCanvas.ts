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

export class DagCanvas {
    private pendingSource: FlowNodeId | null = null;

    constructor(
        private readonly root: HTMLElement,
        private readonly options: DagCanvasOptions,
    ) {}

    render(
        draft: FlowDraft,
        selectedId?: FlowNodeId,
        manifests?: ReadonlyMap<string, DagPluginManifest>,
        selectedEdgeId?: string,
    ): void {
        const positions = draft.layout.nodes ?? {};
        const zoom = draft.layout.viewport?.zoom ?? 1;
        const { width, height } = surfaceSize(draft.nodes, positions);
        this.root.innerHTML = `<div class="dag-canvas__surface" style="transform:scale(${zoom});width:${width}px;height:${height}px">
            <svg class="dag-canvas__edges">${edgeDefs()}${draft.edges.map(edge => {
                const from = positions[edge.from] ?? { x: 40, y: 40 };
                const to = positions[edge.to] ?? { x: 40, y: 40 };
                const marker = edge.kind === 'control' ? 'dag-arrow-control' : 'dag-arrow-data';
                const id = escapeHTML(String(edge.id));
                const lane = edge.output === 'repeat' ? Math.max(...Object.values(positions).map(position => position.y), 0) + 160 : undefined;
                const path = edgePath(from, to, lane);
                return `<path data-edge-id="${id}" d="${path}" class="dag-edge-hit"></path><path data-edge-id="${id}" d="${path}" class="is-${edge.kind}${String(edge.id) === selectedEdgeId ? ' is-selected' : ''}" marker-end="url(#${marker})"></path>`;
            }).join('')}</svg>
            ${draft.nodes.map(node => renderNode(node, positions[node.id], node.id === selectedId, manifests?.get(String(node.id)) ?? manifests?.get(`${node.plugin}@${node.pluginVersion}`))).join('')}
        </div>`;
        this.bind(draft);
    }

    fit(): void {
        this.root.querySelector('.dag-canvas__surface')?.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
        });
    }

    private bind(draft: FlowDraft): void {
        this.root.addEventListener('click', event => {
            const target = event.target as HTMLElement;
            if (target.closest('[data-flow-node], [data-edge-id]')) return;
            this.pendingSource = null;
            this.root.classList.remove('is-connecting');
            this.options.onSelectCanvas?.();
        });
        this.root.querySelectorAll<SVGPathElement>('[data-edge-id]').forEach(path => {
            path.addEventListener('click', event => {
                event.stopPropagation();
                this.pendingSource = null;
                this.root.classList.remove('is-connecting');
                this.options.onSelectEdge?.(path.dataset.edgeId!);
            });
        });
        this.root.querySelectorAll<HTMLElement>('[data-flow-node]').forEach(element => {
            const nodeId = element.dataset.flowNode as FlowNodeId;
            element.addEventListener('click', event => this.handleNodeClick(event, draft, nodeId));
            element.addEventListener('dblclick', event => {
                event.stopPropagation();
                this.options.onEditNode?.(nodeId);
            });
            element.addEventListener('pointerdown', event => this.startDrag(event, nodeId, element));
            element.querySelector<HTMLElement>('[data-port="output"]')?.addEventListener('pointerdown', event => {
                this.beginConnectionDrag(event, draft, nodeId);
            });
        });
    }

    private handleNodeClick(event: MouseEvent, draft: FlowDraft, nodeId: FlowNodeId): void {
        event.stopPropagation();
        const node = draft.nodes.find(item => item.id === nodeId);
        if (!node) return;
        if ((event.target as HTMLElement).closest('[data-port="output"]')) {
            this.pendingSource = nodeId;
            this.root.classList.add('is-connecting');
            return;
        }
        if ((event.target as HTMLElement).closest('[data-port="input"]') && this.pendingSource) {
            const source = draft.nodes.find(item => item.id === this.pendingSource);
            this.pendingSource = null;
            this.root.classList.remove('is-connecting');
            if (source) this.options.onConnect(source, node);
            return;
        }
        this.options.onSelectNode(nodeId);
    }

    private beginConnectionDrag(event: PointerEvent, draft: FlowDraft, sourceId: FlowNodeId): void {
        event.stopPropagation();
        this.pendingSource = sourceId;
        this.root.classList.add('is-connecting');
        const finish = (next: PointerEvent) => {
            document.removeEventListener('pointerup', finish);
            const input = (next.target as HTMLElement | null)?.closest<HTMLElement>('[data-flow-node] [data-port="input"]');
            if (!input) return; // Keep click-to-connect mode active as a fallback.
            const targetElement = input.closest<HTMLElement>('[data-flow-node]');
            const source = draft.nodes.find(node => node.id === sourceId);
            const target = draft.nodes.find(node => node.id === targetElement?.dataset.flowNode);
            this.pendingSource = null;
            this.root.classList.remove('is-connecting');
            if (source && target) this.options.onConnect(source, target);
        };
        document.addEventListener('pointerup', finish);
    }

    private startDrag(event: PointerEvent, nodeId: FlowNodeId, element: HTMLElement): void {
        if ((event.target as HTMLElement).closest('[data-port]')) return;
        const start = { x: event.clientX, y: event.clientY };
        let moved = false;
        const position = {
            x: Number.parseFloat(element.style.left) || 0,
            y: Number.parseFloat(element.style.top) || 0,
        };
        element.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => {
            const deltaX = next.clientX - start.x;
            const deltaY = next.clientY - start.y;
            if (!moved && Math.hypot(deltaX, deltaY) < 4) return;
            moved = true;
            element.classList.add('is-dragging');
            element.style.left = `${position.x + deltaX}px`;
            element.style.top = `${position.y + deltaY}px`;
        };
        element.addEventListener('pointermove', move);
        element.addEventListener('pointerup', next => {
            element.removeEventListener('pointermove', move);
            element.classList.remove('is-dragging');
            // A click must not rebuild the canvas before the browser dispatches
            // its click event; only commit an actual drag.
            if (!moved) return;
            this.options.onMoveNode(nodeId, {
                x: position.x + next.clientX - start.x,
                y: position.y + next.clientY - start.y,
            });
        }, { once: true });
    }
}

function renderNode(
    node: FlowNodeDefinition,
    position = { x: 40, y: 40 },
    selected = false,
    manifest?: DagPluginManifest,
): string {
    const inputs = portSummary(manifest?.inputs);
    const outputs = portSummary(manifest?.outputs);
    return `<article class="dag-node ${selected ? 'is-selected' : ''}"
        data-flow-node="${escapeHTML(node.id)}" style="left:${position.x}px;top:${position.y}px">
        <button class="dag-port dag-port--input" data-port="input" title="Connect input"></button>
        <strong>${escapeHTML(node.name)}</strong>
        <small class="dag-node__kind">${escapeHTML(manifest?.title ?? node.plugin)}</small>
        ${nodeBadges(node)}
        <small class="dag-node__ports" title="${escapeHTML(node.plugin)}@${escapeHTML(node.pluginVersion)}">In ${escapeHTML(inputs)} · Out ${escapeHTML(outputs)}</small>
        <button class="dag-port dag-port--output" data-port="output" title="Connect output"></button>
    </article>`;
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

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, lane?: number): string {
    const startX = from.x + 180;
    const startY = from.y + 42;
    const endX = to.x;
    const endY = to.y + 42;
    if (lane !== undefined) return `M ${startX} ${startY} L ${startX + 30} ${startY} L ${startX + 30} ${lane} L ${endX - 30} ${lane} L ${endX - 30} ${endY} L ${endX} ${endY}`;
    const bend = Math.max(40, Math.abs(endX - startX) / 2);
    return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

/** Arrowhead markers for edge direction (data = solid blue, control = dashed violet). */
function edgeDefs(): string {
    const marker = (id: string, color: string) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"></path>
        </marker>`;
    return `<defs>${marker('dag-arrow-data', '#60a5fa')}${marker('dag-arrow-control', '#a78bfa')}</defs>`;
}

/** Grow the surface to fit every node so the canvas can scroll to offscreen nodes. */
function surfaceSize(
    nodes: FlowNodeDefinition[],
    positions: Record<string, { x: number; y: number }>,
): { width: number; height: number } {
    let width = 1200;
    let height = 760;
    for (const node of nodes) {
        const position = positions[node.id] ?? { x: 40, y: 40 };
        width = Math.max(width, position.x + 220);
        height = Math.max(height, position.y + 200);
    }
    return { width, height };
}
