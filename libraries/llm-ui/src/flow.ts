import './flow.css';
import type { JsonValue, OperationContext, OperationKind, OperationReceipt } from './contracts';
import type { FlowActionName, FlowEndpoint, FlowNodeChange, FlowNodeView, FlowOptions, FlowSnapshot, FlowView, MountedFlowInspector } from './flow-contracts';
import { button, disposeAll, element, errorText } from './dom';
import { mountFlowInspector } from './flow-inspector';

export type * from './flow-contracts';
export { createOperationLedger } from './operations';
const zh: Record<string, string> = { addNode: '添加节点', updateNode: '更新节点', removeNode: '删除节点', connect: '连接', disconnect: '断开连接',
    save: '保存', run: '运行', cancel: '停止', refresh: '刷新', apply: '应用', name: '名称', accepted: '已接纳', reconcile: '核对操作',
    waitingChanges: '等待已保存的节点更新' };

class FlowController implements FlowView {
    private readonly root = element('section', 'llm-flow');
    private readonly toolbar = element('header', 'llm-flow__toolbar');
    private readonly palette = element('aside', 'llm-flow__palette');
    private readonly canvas = element('div', 'llm-flow__canvas');
    private readonly edges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    private readonly inspector = element('aside', 'llm-flow__inspector');
    private readonly output = element('pre', 'llm-flow__output');
    private readonly feedback = element('div', 'llm-flow__error');
    private readonly disposers: (() => void | Promise<void>)[] = [];
    private readonly inFlight = new Set<string>();
    private readonly nodes = new Map<string, HTMLElement>();
    private readonly t: (key: string) => string;
    private snapshot!: FlowSnapshot;
    private binding?: string;
    private flowId?: string;
    private selected?: string;
    private connecting?: { endpoint: FlowEndpoint; revision: number };
    private mounted?: MountedFlowInspector;
    private inspectorVersion = 0;
    private waitingInspector?: { id: string; revision: number; change: FlowNodeChange };
    private active = true;
    private closed = false;
    private disposed?: Promise<void>;
    constructor(container: HTMLElement, private readonly options: FlowOptions) {
        this.t = key => options.translate?.(key) ?? (options.locale === 'en' ? key : zh[key] ?? key);
        const body = element('div', 'llm-flow__workspace'); body.append(this.palette, this.canvas, this.inspector);
        this.canvas.tabIndex = 0; this.canvas.append(this.edges);
        this.root.append(this.toolbar, body, this.output, this.feedback); container.append(this.root);
    }
    initialize(): void {
        if (Object.keys(this.options.actions).some(key => key !== 'reconcile') && !this.options.actions.reconcile)
            throw new Error('Mutating Flow hosts must provide reconciliation');
        this.disposers.push(this.options.source.subscribe(() => this.changed()));
        this.disposers.push(this.options.operations.subscribe(() => { if (!this.closed && this.active) this.renderOperations(); }));
        this.changed();
        const slot = this.options.mountToolbar?.(this.toolbar, this.snapshot); if (slot) this.disposers.push(() => slot.destroy());
    }
    private changed(): void {
        if (this.closed) return;
        const next = this.options.source.getSnapshot();
        this.binding ??= next.viewId; this.flowId ??= next.flowId;
        if (next.viewId !== this.binding || next.flowId !== this.flowId || this.snapshot && next.revision < this.snapshot.revision) return;
        this.snapshot = next;
        if (this.active) this.render();
    }
    private render(): void {
        this.refreshInspector();
        this.renderToolbar(); this.renderPalette(); this.renderNodes(); this.renderEdges(); this.renderOperations();
        if (this.selected && !this.snapshot.nodes.some(node => node.id === this.selected)) this.clearInspector();
        this.output.textContent = this.snapshot.execution ? JSON.stringify(this.snapshot.execution, null, 2) : '';
    }
    private renderToolbar(): void {
        this.toolbar.querySelectorAll('[data-flow-action]').forEach(node => node.remove());
        const title = element('strong', undefined, this.snapshot.title); title.dataset.flowAction = 'title'; this.toolbar.prepend(title);
        for (const name of ['save', 'run', 'cancel'] as const) if (this.can(name)) {
            const revision = this.snapshot.graphRevision, executionRef = this.snapshot.execution?.executionRef;
            if (name === 'cancel' && !executionRef) continue;
            const control = button(this.t(name), () => this.launch(name, name === 'cancel' ? executionRef! : revision,
                context => name === 'cancel' ? this.options.actions.cancel!(executionRef!, context) : this.options.actions[name]!(revision, context)));
            control.dataset.flowAction = name; this.toolbar.append(control);
        }
        if (this.options.source.refresh) {
            const control = button(this.t('refresh'), () => { void this.options.source.refresh!().catch(error => this.report(error)); });
            control.dataset.flowAction = 'refresh'; this.toolbar.append(control);
        }
    }
    private renderPalette(): void {
        this.palette.replaceChildren();
        for (const type of this.snapshot.nodeTypes) {
            const control = button(type.label, () => this.launch('addNode', type.id,
                context => this.options.actions.addNode!(type.id, { x: 24, y: this.snapshot.nodes.length * 120 + 24 }, context)));
            control.title = type.description ?? ''; control.disabled = !this.can('addNode'); this.palette.append(control);
        }
    }
    private renderNodes(): void {
        const ids = new Set(this.snapshot.nodes.map(node => node.id));
        for (const [id, view] of this.nodes) if (!ids.has(id)) { view.remove(); this.nodes.delete(id); }
        for (const node of this.snapshot.nodes) {
            let view = this.nodes.get(node.id);
            if (!view) { view = element('article', 'llm-flow__node'); view.dataset.nodeId = node.id; this.nodes.set(node.id, view); this.canvas.append(view); }
            view.style.left = `${node.position.x}px`; view.style.top = `${node.position.y}px`;
            view.dataset.selected = String(this.selected === node.id); view.replaceChildren();
            const heading = button(node.name, () => this.selectNode(node.id)); view.append(heading);
            this.bindDrag(heading, view, node);
            this.ports(view, node, 'inputs'); this.ports(view, node, 'outputs');
            const state = this.snapshot.execution?.nodes[node.id]; if (state) view.append(element('small', undefined, state.state));
        }
    }
    private ports(view: HTMLElement, node: FlowNodeView, side: 'inputs' | 'outputs'): void {
        const ports = element('div', 'llm-flow__ports');
        for (const port of node[side]) {
            const endpoint = { nodeId: node.id, portId: port.id };
            const control = button(port.label, () => {
                if (side === 'outputs') { this.connecting = { endpoint, revision: this.snapshot.graphRevision }; return; }
                const from = this.connecting; if (!from) return; this.connecting = undefined;
                const edge = { from: { ...from.endpoint }, to: endpoint, expectedGraphRevision: from.revision };
                this.launch('connect', edge, context => this.options.actions.connect!(edge, context));
            });
            control.dataset.portId = port.id; control.dataset.portSide = side; control.disabled = !this.can('connect'); ports.append(control);
        }
        view.append(ports);
    }
    private renderEdges(): void {
        this.edges.replaceChildren();
        for (const edge of this.snapshot.edges) {
            const from = this.snapshot.nodes.find(node => node.id === edge.from.nodeId), to = this.snapshot.nodes.find(node => node.id === edge.to.nodeId);
            if (!from || !to) continue;
            const line = document.createElementNS(this.edges.namespaceURI, 'path');
            const x = from.position.x + 190, y = from.position.y + 50, end = to.position;
            line.setAttribute('d', `M ${x} ${y} C ${x + 60} ${y}, ${end.x - 60} ${end.y + 50}, ${end.x} ${end.y + 50}`);
            line.setAttribute('aria-label', edge.label ?? edge.id); line.setAttribute('tabindex', '0');
            const disconnect = () => { const target = { edgeId: edge.id, expectedRevision: edge.revision };
                this.launch('disconnect', target, context => this.options.actions.disconnect!(target, context)); };
            if (this.can('disconnect')) { line.addEventListener('dblclick', disconnect); line.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Delete') disconnect(); }); }
            this.edges.append(line);
        }
    }
    private bindDrag(handle: HTMLElement, view: HTMLElement, node: FlowNodeView): void {
        handle.addEventListener('pointerdown', event => {
            if (!this.can('updateNode') || event.button !== 0) return;
            const abort = new AbortController(), start = { x: event.clientX, y: event.clientY }; let position = node.position;
            const move = (next: PointerEvent) => {
                position = { x: Math.max(0, node.position.x + next.clientX - start.x), y: Math.max(0, node.position.y + next.clientY - start.y) };
                view.style.left = `${position.x}px`; view.style.top = `${position.y}px`;
            };
            window.addEventListener('pointermove', move, { signal: abort.signal });
            window.addEventListener('pointerup', () => {
                abort.abort(); if (position !== node.position) void this.commit(node, { position }).catch(error => this.report(error));
            }, { signal: abort.signal });
            window.addEventListener('pointercancel', () => { abort.abort(); if (!this.closed) this.renderNodes(); }, { signal: abort.signal });
            this.disposers.push(() => abort.abort());
        });
    }
    selectNode(id: string): void {
        if (this.closed) return;
        const node = this.snapshot.nodes.find(item => item.id === id); if (!node) return;
        this.clearInspector(); this.selected = id;
        const version = this.inspectorVersion;
        const context = { node, snapshot: this.snapshot, canEdit: this.can('updateNode'),
            commit: (change: FlowNodeChange) => this.commitInspector(node, change, version) };
        try { this.mounted = this.options.mountInspector?.(this.inspector, context) ?? mountFlowInspector(this.inspector, context, this.t); }
        catch (error) { this.report(error); }
        if (this.can('removeNode')) this.inspector.append(button(this.t('removeNode'), () => {
            const target = { nodeId: node.id, expectedRevision: node.revision };
            this.launch('removeNode', target, operation => this.options.actions.removeNode!(target, operation));
        }));
        this.renderNodes();
    }
    private commit(node: FlowNodeView, change: FlowNodeChange): Promise<void> {
        const target = { nodeId: node.id, expectedRevision: node.revision };
        return this.perform('updateNode', { ...target, ...change } as JsonValue, context => this.options.actions.updateNode!(target, change, context));
    }
    private async commitInspector(node: FlowNodeView, change: FlowNodeChange, version: number): Promise<void> {
        await this.commit(node, change);
        if (this.closed || this.inspectorVersion !== version) return;
        this.clearInspector(); this.selected = node.id;
        this.waitingInspector = { id: node.id, revision: node.revision, change };
        this.inspector.textContent = this.t('waitingChanges');
        this.refreshInspector();
    }
    private refreshInspector(): void {
        const pending = this.waitingInspector;
        if (!pending) return;
        const node = this.snapshot.nodes.find(item => item.id === pending.id);
        if (node && (node.revision !== pending.revision || matchesChange(node, pending.change))) this.selectNode(node.id);
    }
    private clearInspector(): void {
        ++this.inspectorVersion; this.waitingInspector = undefined;
        const mounted = this.mounted; this.mounted = undefined; this.selected = undefined; this.inspector.replaceChildren();
        if (mounted) { const task = Promise.resolve().then(() => mounted.destroy()); void task.catch(() => {}); this.disposers.push(() => task); }
    }
    private can(name: FlowActionName): boolean { return !!this.options.actions[name] && this.snapshot.allowed.includes(name); }
    private launch(name: FlowActionName, input: JsonValue, action: (context: OperationContext) => Promise<OperationReceipt>): void {
        void this.perform(name, input, action).catch(error => this.report(error));
    }
    private async perform(name: FlowActionName, input: JsonValue, action: (context: OperationContext) => Promise<OperationReceipt>): Promise<void> {
        if (this.closed || !this.can(name)) throw new Error('Flow operation unavailable');
        if (this.options.operations.getSnapshot().some(record => record.conversationId === this.snapshot.flowId
            && record.kind.startsWith('flow.') && (record.status === 'unknown' || record.status === 'submitting')))
            throw new Error('A Flow operation is awaiting reconciliation');
        const key = `${name}:${JSON.stringify(input)}`; if (this.inFlight.has(key)) return; this.inFlight.add(key);
        const context = { viewId: this.snapshot.viewId, operationId: crypto.randomUUID() };
        try {
            await this.options.operations.register({ context, conversationId: this.snapshot.flowId, kind: flowKind(name), input, status: 'submitting' });
            let receipt: OperationReceipt;
            try { receipt = await action(context); }
            catch (error) { receipt = { status: 'unknown', operationId: context.operationId, message: errorText(error) }; }
            if (receipt.operationId !== context.operationId) receipt = { status: 'unknown', operationId: context.operationId, message: 'Mismatched receipt identity' };
            await this.options.operations.settle(receipt);
            const result = this.options.operations.getSnapshot().find(record => record.context.operationId === context.operationId)!;
            if (result.status !== 'accepted') throw new Error(result.message ?? result.status);
        } finally { this.inFlight.delete(key); }
    }
    async reconcile(operationId: string): Promise<void> {
        const record = this.options.operations.getSnapshot().find(item => item.conversationId === this.snapshot.flowId && item.context.operationId === operationId);
        if (!record || !this.options.actions.reconcile) return;
        const receipt = await this.options.actions.reconcile(operationId);
        if (receipt.operationId !== operationId) throw new Error('Mismatched receipt identity');
        await this.options.operations.settle(receipt);
    }
    private renderOperations(): void {
        this.feedback.replaceChildren(element('p', undefined, this.snapshot.error ?? ''));
        for (const record of this.options.operations.getSnapshot()) {
            if (record.conversationId !== this.snapshot.flowId || record.status === 'accepted') continue;
            const row = element('p', undefined, record.message ?? record.status);
            if ((record.status === 'unknown' || record.status === 'submitting') && this.options.actions.reconcile) row.append(button(this.t('reconcile'), () => {
                void this.reconcile(record.context.operationId).catch(error => this.report(error));
            }));
            this.feedback.append(row);
        }
    }
    private report(error: unknown): void { if (!this.closed) this.feedback.textContent = errorText(error); this.options.onError?.(error); }
    setActive(active: boolean): void { if (this.closed) return; this.active = active; if (active) this.changed(); }
    focus(): void { if (!this.closed && this.active) this.canvas.focus(); }
    destroy(): Promise<void> {
        if (this.disposed) return this.disposed;
        this.closed = true; this.clearInspector();
        return this.disposed = disposeAll([...this.disposers, () => this.root.remove()]);
    }
}
function matchesChange(node: FlowNodeView, change: FlowNodeChange): boolean {
    return (change.name === undefined || change.name === node.name)
        && (change.config === undefined || JSON.stringify(change.config) === JSON.stringify(node.config))
        && (change.position === undefined || change.position.x === node.position.x && change.position.y === node.position.y);
}
function flowKind(name: FlowActionName): OperationKind {
    return ({ addNode: 'flow.add-node', updateNode: 'flow.update-node', removeNode: 'flow.remove-node', connect: 'flow.connect',
        disconnect: 'flow.disconnect', save: 'flow.save', run: 'flow.run', cancel: 'flow.cancel' } as const)[name];
}
export async function createFlowView(container: HTMLElement, options: FlowOptions): Promise<FlowView> {
    const controller = new FlowController(container, options);
    try { controller.initialize(); return controller; }
    catch (error) {
        try { await controller.destroy(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Flow initialization failed'); }
        throw error;
    }
}
