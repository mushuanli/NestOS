import {flowImageAssets} from './image-assets';
import { flowConnectionSelection } from './connection-selection';
import { escapeHTML, randomUUID, t } from '@itookit/common';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { type FlowParameter, type JsonValue } from '@itookit/llm-flow/contracts';
import { formatFlowOutput } from '@itookit/llm-flow/contracts';
import { FlowInvocationCommand, type FlowInvocationRecord } from '@itookit/llm-session/contracts';
import { FlowCommand, type DurableFlowSnapshot } from '@itookit/llm-flow/contracts';
import type { InteractionRequest, TaskRecord } from '@itookit/durable-kernel/contracts';
import { InteractionPanel } from '../components/input/InteractionPanel';
import { promptFlowParameters } from '../components/FlowParameterForm';
import { DagWorkbench } from '../components/DagWorkbench';
import { inputInteraction } from '../shell/input-interaction';

const terminal = (status: string) => ['succeeded', 'failed', 'cancelled'].includes(status);
interface Card { element: HTMLElement; interactions: Map<string, InteractionPanel | HTMLElement>; snapshot?: DurableFlowSnapshot; active: boolean }

/** Persistent call identities drive cards; Kernel snapshots drive their execution state. */
export class InvocationPanel {
    private cards = new Map<string, Card>();
    private abort = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private refreshing?: Promise<void>;
    private refreshFailed = false;
    private visible = true;
    private actions = new Set<string>();
    private element = document.createElement('section');
    constructor(private commands: ICommandBus, private sessionId: string, parent: HTMLElement, private useResult: (text: string) => void) {
        this.element.className = 'flow-invocations'; this.element.hidden = true;
        this.element.setAttribute('aria-label', t('flow.invoke.calls')); parent.append(this.element);
        const refreshVisible = () => { if (!document.hidden) void this.refresh(); };
        window.addEventListener('focus', refreshVisible, { signal: this.abort.signal });
        document.addEventListener('visibilitychange', refreshVisible, { signal: this.abort.signal });
        void this.refresh();
    }

    refresh(): Promise<void> {
        if (this.abort.signal.aborted || !this.visible) return Promise.resolve();
        if (this.refreshing) return this.refreshing;
        this.refreshing = this.load().then(() => { this.refreshFailed = false; }).catch(error => {
            this.refreshFailed = true;
            if (!this.abort.signal.aborted) this.element.setAttribute('title', String(error));
        }).finally(() => {
            this.refreshing = undefined; clearTimeout(this.timer);
            const active = this.refreshFailed || [...this.cards.values()].some(card => card.active);
            // Idle polling remains a fallback for changes made by another host.
            if (!this.abort.signal.aborted && this.visible) this.timer = setTimeout(() => { void this.refresh(); }, active ? 1000 : 30_000);
        });
        return this.refreshing;
    }

    setVisible(visible: boolean): void {
        this.visible = visible; clearTimeout(this.timer);
        if (visible) void this.refresh();
    }
    async hasActive(): Promise<boolean> {
        await this.refresh();
        return [...this.cards.values()].some(card => card.active);
    }

    async taskIds(): Promise<Set<string>> {
        await this.refresh();
        return new Set([...this.cards.values()].flatMap(card => card.snapshot?.taskTree.map(task => task.id) ?? []));
    }

    destroy(): void {
        this.abort.abort(); clearTimeout(this.timer);
        for (const card of this.cards.values()) for (const panel of card.interactions.values()) if (panel instanceof InteractionPanel) panel.clear();
        this.cards.clear(); this.element.remove();
    }

    private async load(): Promise<void> {
        const calls = await this.commands.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, { sessionId: this.sessionId });
        if (this.abort.signal.aborted || !this.visible) return;
        this.element.hidden = !calls.length;
        for (const call of calls) {
            let card = this.cards.get(call.requestId);
            if (!card) { card = this.createCard(call); this.cards.set(call.requestId, card); }
            if (!call.rootTaskId) { card.active = !call.error; card.element.querySelector('[data-status]')!.textContent = call.error ?? t('flow.output.pending'); continue; }
            try {
                const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { sessionId: this.sessionId, taskId: call.rootTaskId });
                if (this.abort.signal.aborted || !this.visible) return;
                card.snapshot = snapshot; this.updateCard(card, call, snapshot);
            } catch (error) { card.element.querySelector('[data-status]')!.textContent = String(error); }
        }
    }

    private createCard(call: FlowInvocationRecord): Card {
        const element = document.createElement('article'); element.className = 'flow-invocations__card';
        element.dataset.invocation = call.requestId;
        element.innerHTML = `<header><strong>${escapeHTML(call.flow.name)} · v${call.revision}</strong><span data-status role="status"></span></header>
            <details><summary>${escapeHTML(call.flowId)}</summary><pre>${escapeHTML(JSON.stringify(call.parameters, null, 2))}</pre></details>
            <div data-actions></div><pre data-result></pre><div data-interactions></div><p data-error role="alert"></p>`;
        this.element.append(element);
        return { element, interactions: new Map(), active: !call.error };
    }

    private updateCard(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task;
        card.active = !terminal(task.status);
        card.element.querySelector('[data-status]')!.textContent = t(`flow.invoke.${task.status}` as Parameters<typeof t>[0]);
        const returned = (task.output as { nodes?: Record<string, unknown> } | undefined)?.nodes?.__flow_return;
        const result = formatFlowOutput(returned ?? task.output ?? task.exit?.error ?? task.lastError ?? '');
        card.element.querySelector('[data-result]')!.textContent = result;
        const actions = card.element.querySelector<HTMLElement>('[data-actions]')!;
        actions.replaceChildren();
        this.button(actions, 'flow.invoke.details', () => this.details(call.rootTaskId!));
        this.button(actions, 'flow.invoke.repeat', () => this.repeat(call));
        if (!terminal(task.status)) {
            this.button(actions, 'flow.invoke.cancel', () => this.control(call, FlowCommand.RunCancel));
            this.button(actions, 'flow.invoke.resume', () => this.control(call, FlowCommand.RunResume));
        }
        if (task.status === 'succeeded') this.button(actions, 'flow.invoke.use', async () => this.useResult(`${call.flow.name}\n${result}`));
        this.updateInteractions(card, call, terminal(task.status) ? [] : snapshot.taskTree);
    }

    private updateInteractions(card: Card, call: FlowInvocationRecord, tasks: TaskRecord[]): void {
        const current = new Set<string>(), container = card.element.querySelector<HTMLElement>('[data-interactions]')!;
        for (const task of tasks.filter(item => !terminal(item.status))) for (const request of Object.values(task.interactions ?? {})) {
            if (request.status !== 'pending') continue;
            const key = `${task.id}/${request.id}`; current.add(key);
            if (card.interactions.has(key)) continue;
            const respond = async (value: JsonValue) => {
                if (this.abort.signal.aborted) throw new Error('Invocation view closed');
                const fresh = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { sessionId: this.sessionId, taskId: call.rootTaskId });
                const target = fresh.taskTree.find(item => item.id === task.id);
                if (terminal(fresh.root.task.status) || !target || terminal(target.status) || target.interactions[request.id]?.status !== 'pending') throw new Error('Interaction is no longer pending');
                await this.commands.execute(FlowCommand.RunRespond, { taskId: call.rootTaskId, targetTaskId: task.id, requestId: request.id, value });
            };
            card.interactions.set(key, this.showInteraction(container, request, key, respond));
        }
        for (const [key, panel] of card.interactions) if (!current.has(key)) {
            if (panel instanceof InteractionPanel) panel.clear(); else panel.remove();
            card.interactions.delete(key);
        }
    }

    private showInteraction(container: HTMLElement, request: InteractionRequest<JsonValue>, key: string, respond: (value: JsonValue) => Promise<void>): InteractionPanel | HTMLElement {
        const payload = request.payload as { fields?: Record<string, object>; values?: Record<string, JsonValue> } | null;
        if (request.kind === 'input' && payload?.fields) {
            const button = this.button(container, 'flow.invoke.reply', async () => {
                const fields = Object.entries(payload.fields!).map(([name, field]) => ({ ...field, name, default: payload.values?.[name] })) as FlowParameter[];
                await promptFlowParameters(fields, request.prompt, respond, this.abort.signal, undefined, flowImageAssets(this.commands));
            });
            button.title = request.prompt; return button;
        }
        const panel = new InteractionPanel(container);
        panel.show({ ...inputInteraction(request, 0), key }, respond, false);
        return panel;
    }

    private button(parent: HTMLElement, key: Parameters<typeof t>[0], action: () => Promise<void>): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t(key);
        const actionId = `${parent.closest<HTMLElement>('article')?.dataset.invocation}/${key}`;
        button.disabled = this.actions.has(actionId);
        button.addEventListener('click', () => {
            if (this.abort.signal.aborted || this.actions.has(actionId)) return;
            this.actions.add(actionId); button.disabled = true; void action().catch(error => {
            const area = parent.closest('article')?.querySelector('[data-error]'); if (area) area.textContent = String(error);
        }).finally(() => { this.actions.delete(actionId); button.disabled = false; if (!this.abort.signal.aborted) void this.refresh(); }); });
        parent.append(button); return button;
    }

    private async control(call: FlowInvocationRecord, command: string): Promise<void> {
        await this.commands.execute(FlowCommand.RunGet, { taskId: call.rootTaskId, sessionId: this.sessionId });
        await this.commands.execute(command, { taskId: call.rootTaskId, sessionId: this.sessionId });
    }

    private async repeat(call: FlowInvocationRecord): Promise<void> {
        const connection = await flowConnectionSelection(this.commands, call.connectionId, call.flow.connections, call.connectionBindings, call.flow);
        const requests = new Map<string, string>();
        const submit = async (parameters: Record<string, JsonValue>) => {
            if (this.abort.signal.aborted) throw new Error('Invocation view closed');
            const key = JSON.stringify([parameters, connection.selected, connection.bindings]), requestId = requests.get(key) ?? randomUUID();
            requests.set(key, requestId);
            await this.commands.execute(FlowInvocationCommand.Invoke, { sessionId: this.sessionId, requestId,
                flowId: call.flowId, revision: call.revision, parameters, connectionId: connection.selected, ...(Object.keys(connection.bindings ?? {}).length ? { connectionBindings: connection.bindings } : {}) });
        };
        const fields = (call.flow.parameters ?? []).map(field => ({ ...field, ...(Object.hasOwn(call.parameters, field.name) ? { default: call.parameters[field.name] } : {}) }));
        await promptFlowParameters(fields, call.flow.name, submit, this.abort.signal, connection);
    }

    private async details(taskId: string): Promise<void> {
        const dialog = document.createElement('dialog'); dialog.className = 'dag-dialog dag-output-dialog';
        const close = document.createElement('button'); close.textContent = t('flow.launch.cancel'); close.onclick = () => dialog.close();
        const body = document.createElement('div'); dialog.append(close, body);
        const workbench = new DagWorkbench(body, { commands: this.commands, readOnly: true });
        const abort = () => dialog.close(); this.abort.signal.addEventListener('abort', abort, { once: true });
        dialog.addEventListener('close', () => { workbench.destroy(); dialog.remove(); this.abort.signal.removeEventListener('abort', abort); }, { once: true });
        document.body.append(dialog); dialog.showModal(); await workbench.openRun(taskId, this.sessionId);
    }
}
