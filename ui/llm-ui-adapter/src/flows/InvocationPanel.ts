import {flowImageAssets} from './image-assets';
import { promptInvocation } from './prompt-invocation';
import { flowConnectionSelection } from './connection-selection';
import { escapeHTML, t } from '@itookit/common';
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
interface Card { element: HTMLElement; interactions: Map<string, InteractionPanel | HTMLElement>; snapshot?: DurableFlowSnapshot; active: boolean; actionsKey?: string; loadError?: boolean; unmount?: () => void }

/** Persistent call identities drive cards; Kernel snapshots drive their execution state. */
export class InvocationPanel {
    private cards = new Map<string, Card>();
    private abort = new AbortController();
    private viewAbort = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private refreshing?: Promise<void>;
    private refreshFailed = false;
    private visible = true;
    private actions = new Set<string>();
    private element = document.createElement('section');
    private summary = document.createElement('p');
    private error = document.createElement('p');
    constructor(private commands: ICommandBus, private sessionId: string, parent: HTMLElement, private useResult: (text: string) => void, private options: {
        mountCard?(card: HTMLElement, call: FlowInvocationRecord): () => void; openChild?(id: string): void | Promise<void>;
    } = {}) {
        this.element.className = 'flow-invocations'; this.element.hidden = true;
        this.element.setAttribute('aria-label', t('flow.invoke.calls')); parent.append(this.element);
        this.summary.className = 'flow-invocations__summary'; this.summary.setAttribute('role', 'status');
        this.error.setAttribute('role', 'alert'); this.element.append(this.summary, this.error);
        const receiver = document.createElement('small'); receiver.textContent = t('flow.invoke.receiver'); this.element.append(receiver);
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
            if (!this.abort.signal.aborted) this.error.textContent = t('flow.invoke.refreshFailed', {reason: String(error)});
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
        if (!visible) this.viewAbort.abort();
        else if (this.viewAbort.signal.aborted) this.viewAbort = new AbortController();
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
        this.abort.abort(); this.viewAbort.abort(); clearTimeout(this.timer);
        for (const card of this.cards.values()) { card.unmount?.(); card.element.remove(); }
        for (const card of this.cards.values()) for (const panel of card.interactions.values()) if (panel instanceof InteractionPanel) panel.clear();
        this.cards.clear(); this.element.remove();
    }

    private async load(): Promise<void> {
        const calls = await this.commands.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, { sessionId: this.sessionId });
        if (this.abort.signal.aborted || !this.visible) return;
        this.element.hidden = !calls.length; this.error.textContent = '';
        let failed = false, failure: unknown;
        for (const call of calls) {
            let card = this.cards.get(call.requestId);
            if (!card) { card = this.createCard(call); this.cards.set(call.requestId, card); }
            if (!call.rootTaskId) { card.active = !call.error; card.element.querySelector('[data-status]')!.textContent = call.error ?? t('flow.output.pending'); continue; }
            try {
                const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { sessionId: this.sessionId, taskId: call.rootTaskId });
                if (this.abort.signal.aborted || !this.visible) return;
                if (card.loadError) {card.element.querySelector('[data-error]')!.textContent = ''; card.loadError = false;}
                card.snapshot = snapshot; this.updateCard(card, call, snapshot);
            } catch (error) { failed = true; failure = error; card.loadError = true; card.element.querySelector('[data-error]')!.textContent = t('flow.invoke.refreshFailed', {reason: String(error)}); }
        }
        this.updateSummary();
        if (failed) throw failure;
    }

    private updateSummary(): void {
        const cards = [...this.cards.values()], active = cards.filter(card => card.active).length;
        const waiting = cards.reduce((count, card) => count + [...card.interactions].length, 0);
        this.summary.textContent = t('flow.invoke.summary', {active, waiting, total: cards.length});
    }

    private createCard(call: FlowInvocationRecord): Card {
        const element = document.createElement('article'); element.className = 'flow-invocations__card';
        element.dataset.invocation = call.requestId;
        element.innerHTML = `<header><strong>${escapeHTML(call.flow.name)} · v${call.revision}</strong><span data-status role="status"></span></header>
            <p>${escapeHTML(t('flow.invoke.origin', {branch: call.branch ?? 'main'}))}</p>
            <details><summary>${escapeHTML(t('flow.invoke.inputs'))}</summary>${this.inputSources(call)}<pre>${escapeHTML(JSON.stringify(call.parameters, null, 2))}</pre></details>
            <div data-actions></div><details><summary>${escapeHTML(t('flow.invoke.result'))}</summary><pre data-result></pre></details><div data-interactions></div><p data-error role="alert"></p>`;
        const unmount = this.options.mountCard?.(element, call);
        if (!this.options.mountCard) this.element.append(element);
        return { element, interactions: new Map(), active: !call.error, unmount };
    }

    private updateCard(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task;
        card.active = !terminal(task.status);
        const pending = snapshot.taskTree.flatMap(member => Object.values(member.interactions ?? {})).filter(request => request.status === 'pending');
        const paused = task.control?.mode === 'pause';
        const label = paused ? 'paused' : pending.some(request => request.kind === 'approval') ? 'waitingApproval'
            : pending.length ? 'waitingInput' : task.status;
        card.element.querySelector('[data-status]')!.textContent = t(`flow.invoke.${label}` as Parameters<typeof t>[0]);
        const returned = (task.output as { nodes?: Record<string, unknown> } | undefined)?.nodes?.__flow_return;
        const result = formatFlowOutput(returned ?? task.output ?? task.exit?.error ?? task.lastError ?? '');
        card.element.querySelector('[data-result]')!.textContent = result;
        this.updateActions(card, call, snapshot);
        this.updateInteractions(card, call, terminal(task.status) ? [] : snapshot.taskTree);
    }

    private inputSources(call: FlowInvocationRecord): string {
        return Object.entries(call.inputTransfers ?? {}).map(([name, transfer]) => `<p>${escapeHTML(t('flow.invoke.source', {
            name, kind: [t(`flow.source.${transfer.selection.kind}` as Parameters<typeof t>[0]), transfer.output?.label].filter(Boolean).join(' · '), count: transfer.messageIds.length,
        }))}</p>`).join('');
    }

    private updateActions(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task, paused = task.control?.mode === 'pause';
        const key = JSON.stringify([task.status, paused, snapshot.attachedFromStorage]);
        if (card.actionsKey === key) return;
        card.actionsKey = key;
        const actions = card.element.querySelector<HTMLElement>('[data-actions]')!; actions.replaceChildren();
        this.button(actions, 'flow.invoke.details', () => this.details(call.rootTaskId!));
        if (terminal(task.status)) this.button(actions, 'flow.invoke.repeat', () => this.repeat(call));
        else {
            this.button(actions, 'flow.invoke.cancel', () => this.control(call, FlowCommand.RunCancel));
            if (snapshot.attachedFromStorage) this.button(actions, 'flow.invoke.resume', () => this.control(call, FlowCommand.RunResume));
            this.button(actions, paused ? 'flow.invoke.continue' : 'flow.invoke.pause', () => this.setPaused(call, !paused));
        }
        if (task.status === 'succeeded') this.button(actions, 'flow.invoke.use', async () => {
            const text = card.element.querySelector('[data-result]')!.textContent ?? '';
            this.useResult(`${call.flow.name}\n${text}`);
        });
    }

    private async setPaused(call: FlowInvocationRecord, paused: boolean): Promise<void> {
        const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {taskId: call.rootTaskId, sessionId: this.sessionId});
        if (terminal(snapshot.root.task.status)) throw new Error(t('flow.rerun.unavailable'));
        await this.commands.execute(FlowCommand.RunGoalUpdate, {taskId: call.rootTaskId, goal: {status: paused ? 'paused' : 'active'}});
    }

    private updateInteractions(card: Card, call: FlowInvocationRecord, tasks: TaskRecord[]): void {
        const current = new Set<string>(), container = card.element.querySelector<HTMLElement>('[data-interactions]')!;
        for (const task of tasks.filter(item => !terminal(item.status))) for (const request of Object.values(task.interactions ?? {})) {
            if (request.status !== 'pending') continue;
            const key = `${task.id}/${request.id}`; current.add(key);
            if (card.interactions.has(key)) continue;
            const respond = async (value: JsonValue) => {
                if (this.abort.signal.aborted || !this.visible) throw new Error('Invocation view closed');
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
                await promptFlowParameters(fields, request.prompt, respond, this.viewAbort.signal, undefined, flowImageAssets(this.commands));
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
            if (this.abort.signal.aborted || !this.visible || this.actions.has(actionId)) return;
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
        const fields = (call.flow.parameters ?? []).map(field => ({ ...field, ...(Object.hasOwn(call.parameters, field.name) ? { default: call.parameters[field.name] } : {}) }));
        await promptInvocation({commands: this.commands, sessionId: this.sessionId, name: call.flow.name, fields, connection,
            signal: this.viewAbort.signal, revision: async () => call.flow, openChild: this.options.openChild});
    }

    private async details(taskId: string): Promise<void> {
        const signal = this.viewAbort.signal;
        const dialog = document.createElement('dialog'); dialog.className = 'dag-dialog dag-output-dialog';
        const close = document.createElement('button'); close.textContent = t('flow.launch.cancel'); close.onclick = () => dialog.close();
        const body = document.createElement('div'); dialog.append(close, body);
        const workbench = new DagWorkbench(body, { commands: this.commands, readOnly: true });
        const abort = () => dialog.close(); signal.addEventListener('abort', abort, { once: true });
        dialog.addEventListener('close', () => { workbench.destroy(); dialog.remove(); signal.removeEventListener('abort', abort); }, { once: true });
        document.body.append(dialog); dialog.showModal(); await workbench.openRun(taskId, this.sessionId);
    }
}
