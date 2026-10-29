import {TaskArtifactBrowser} from '../components/dag/TaskArtifactBrowser';
import {FlowDocuments, flowRequestMarkdown} from '../components/dag/FlowDocuments';
import {InvocationOperations} from './invocation-operations';
import {createOperationLedger, type OperationLedger} from '@itookit/llm-ui';
import {ControlOperations} from './control-operations';
import {FlowRunControl, type PauseResult} from './run-control';
import {flowInputAssets} from './input-assets';
import { promptInvocation } from './prompt-invocation';
import { flowConnectionSelection } from './connection-selection';
import { escapeHTML, t } from '@itookit/common';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { type FlowParameter, type JsonValue } from '@itookit/llm-flow/contracts';
import { formatFlowOutput } from '@itookit/llm-flow/contracts';
import { FlowInvocationCommand, flowInvocationId, type FlowInvocationRecord } from '@itookit/llm-session/contracts';
import { FlowCommand, type DurableFlowSnapshot } from '@itookit/llm-flow/contracts';
import type { InteractionRequest, TaskRecord } from '@itookit/durable-kernel/contracts';
import { InteractionPanel } from '../components/input/InteractionPanel';
import { promptFlowParameters } from '../components/FlowParameterForm';
import {openSessionFlowOutputs} from './session-output';
import { inputInteraction } from '../shell/input-interaction';
import {invocationControl, invocationControlTasks, invocationStatus, type InvocationControl} from './invocation-control';

const terminal = (status: string) => ['succeeded', 'failed', 'cancelled'].includes(status);
interface Card {
    documents: FlowDocuments; result?: string; artifacts: TaskArtifactBrowser; element: HTMLElement; interactions: Map<string, InteractionPanel | HTMLElement>; snapshot?: DurableFlowSnapshot; active: boolean; actionsKey?: string; loadError?: boolean; recoveryNotice?: string; unmount?: () => void }

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
    private operations: OperationLedger;
    private invocationOperations: InvocationOperations;
    private releaseOperations: () => void;
    private readonly invocationRecovery = document.createElement('div');
    private readonly recoveryError = document.createElement('p');
    private controlOperations: ControlOperations;
    private element = document.createElement('section');
    private summary = document.createElement('p');
    private error = document.createElement('p');
    constructor(private commands: ICommandBus, private sessionId: string, parent: HTMLElement, private useResult: (text: string) => void, private options: {
        operations?: OperationLedger;
        mountCard?(card: HTMLElement, call: FlowInvocationRecord): () => void; openChild?(id: string): void | Promise<void>;
    } = {}) {
        this.operations = this.options.operations ?? createOperationLedger();
        this.controlOperations = new ControlOperations(this.operations, this.commands, this.sessionId);
        this.invocationOperations = new InvocationOperations(this.operations, this.commands, this.sessionId);
        this.element.className = 'flow-invocations'; this.element.hidden = true;
        this.element.setAttribute('aria-label', t('flow.invoke.calls')); parent.append(this.element);
        this.summary.className = 'flow-invocations__summary'; this.summary.setAttribute('role', 'status');
        this.error.setAttribute('role', 'alert'); this.element.append(this.summary, this.error, this.invocationRecovery, this.recoveryError);
        this.recoveryError.setAttribute('role', 'alert');
        this.releaseOperations = this.operations.subscribe(() => this.renderInvocationRecovery());
        this.renderInvocationRecovery();
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
        for (const card of this.cards.values()) card.artifacts.setVisible(visible);
        if (!visible) this.viewAbort.abort();
        else if (this.viewAbort.signal.aborted) this.viewAbort = new AbortController();
        if (visible) {this.renderInvocationRecovery(); void this.refresh();}
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
        this.abort.abort(); this.viewAbort.abort(); clearTimeout(this.timer); this.releaseOperations();
        for (const card of this.cards.values()) { card.documents.destroy(); card.artifacts.dispose(); card.unmount?.(); card.element.remove(); }
        for (const card of this.cards.values()) for (const panel of card.interactions.values()) if (panel instanceof InteractionPanel) panel.clear();
        this.cards.clear(); this.element.remove();
    }

    private async load(): Promise<void> {
        const calls = await this.commands.execute<FlowInvocationRecord[]>(FlowInvocationCommand.List, { sessionId: this.sessionId });
        if (this.abort.signal.aborted || !this.visible) return;
        this.element.hidden = !calls.length && !this.invocationOperations.pending().length; this.error.textContent = '';
        let failed = false, failure: unknown;
        for (const call of calls) {
            let card = this.cards.get(call.requestId);
            if (!card) { card = this.createCard(call); this.cards.set(call.requestId, card); }
            this.updateNavigation(card, call);
            if (!call.rootTaskId) { card.active = !call.error; card.element.querySelector('[data-status]')!.textContent = call.error ?? t('flow.output.pending'); continue; }
            try {await this.readCard(card, call);}
            catch (error) { failed = true; failure = error; card.loadError = true; card.element.querySelector('[data-error]')!.textContent = t('flow.invoke.refreshFailed', {reason: String(error)}); }
        }
        this.updateSummary();
        if (failed) throw failure;
    }

    private async readCard(card: Card, call: FlowInvocationRecord): Promise<void> {
        const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: call.executionSessionId ?? this.sessionId, taskId: call.rootTaskId});
        if (this.abort.signal.aborted || !this.visible || olderSnapshot(snapshot, card.snapshot)) return;
        if (card.loadError) {card.element.querySelector('[data-error]')!.textContent = ''; card.loadError = false;}
        assertCallScope(call, snapshot);
        card.snapshot = snapshot; this.updateCard(card, call, snapshot);
    }

    private updateSummary(): void {
        const cards = [...this.cards.values()], active = cards.filter(card => card.active).length;
        const waiting = cards.reduce((count, card) => count + [...card.interactions].length, 0);
        this.summary.textContent = t('flow.invoke.summary', {active, waiting, total: cards.length});
    }

    private createCard(call: FlowInvocationRecord): Card {
        const element = document.createElement('article'); element.className = 'flow-invocations__card';
        element.dataset.invocation = call.requestId;
        element.dataset.invocationId = flowInvocationId(call);
        element.innerHTML = `<header><strong>${escapeHTML(call.flow.name)} · v${call.revision}</strong><span data-status role="status"></span></header>
            <p>${escapeHTML(t('flow.invoke.origin', {branch: call.branch ?? 'main'}))}</p>
            ${this.inputSources(call)}
            <p data-control-notice role="status"></p><div data-control-recovery></div><div data-child-session></div><div data-actions></div><div data-result></div><div data-artifacts></div><div data-interactions></div><p data-error role="alert"></p>`;
        const unmount = this.options.mountCard?.(element, call);
        if (!this.options.mountCard) this.element.append(element);
        const card = { element, documents: new FlowDocuments(), artifacts: new TaskArtifactBrowser(element, this.commands), interactions: new Map(), active: !call.error, unmount };
        this.renderDocument(card, call, t('flow.output.pending'));
        return card;
    }

    private updateCard(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task;
        card.active = !terminal(task.status);
        const control = invocationControl(snapshot), label = invocationStatus(snapshot, control);
        card.element.querySelector('[data-status]')!.textContent = controlStatusText(control, label);
        card.element.querySelector('[data-control-notice]')!.textContent = controlNotice(control, card.recoveryNotice);
        const returned = (task.output as { nodes?: Record<string, unknown> } | undefined)?.nodes?.__flow_return;
        const result = formatFlowOutput(returned ?? task.output ?? task.exit?.error ?? task.lastError ?? '');
        card.result = result; this.renderDocument(card, call, result);
        card.element.querySelector('[data-artifacts]')!.innerHTML = terminal(task.status) && task.output !== undefined
            ? card.artifacts.render({sessionId: task.sessionId, taskId: task.id}) : '';
        this.updateActions(card, call, snapshot);
        this.updateControlRecovery(card, call);
        this.updateInteractions(card, call, terminal(task.status) ? [] : invocationControlTasks(snapshot));
    }

    private renderDocument(card: Card, call: FlowInvocationRecord, result: string): void {
        const request = flowRequestMarkdown(call.inputResolution?.parameters ?? call.parameters);
        card.documents.mount(card.element.querySelector('[data-result]')!, flowInvocationId(call), t('flow.invoke.result'),
            `## ${t('flow.invoke.inputs')}\n\n${request}\n\n## ${t('flow.invoke.result')}\n\n${result}`);
    }

    private inputSources(call: FlowInvocationRecord): string {
        return Object.entries(call.inputTransfers ?? {}).map(([name, transfer]) => `<p>${escapeHTML(t('flow.invoke.source', {
            name, kind: [t(`flow.source.${transfer.selection.kind}` as Parameters<typeof t>[0]), transfer.output?.label].filter(Boolean).join(' · '), count: transfer.messageIds.length,
        }))}</p>`).join('');
    }

    private renderInvocationRecovery(): void {
        if (this.abort.signal.aborted || !this.visible) return;
        const records = this.invocationOperations.pending(); this.invocationRecovery.replaceChildren();
        this.element.hidden = !this.cards.size && !records.length;
        for (const record of records) {
            const row = document.createElement('div'); this.invocationRecovery.append(row);
            const request = (record.input as {request?: {flowId?: string}}).request;
            row.append((request?.flowId ?? '') + ' · ');
            const button = this.button(row, 'callable.submission.reconcile', async () => {
                this.recoveryError.textContent = '';
                try {await this.invocationOperations.reconcile(record.context.operationId);}
                catch (error) {if (!this.abort.signal.aborted && this.visible) this.recoveryError.textContent = String(error);}
            });
            button.dataset.invocationReconcile = record.context.operationId;
        }
    }

    private updateNavigation(card: Card, call: FlowInvocationRecord): void {
        const host = card.element.querySelector<HTMLElement>('[data-child-session]')!, id = call.executionSessionId;
        if (host.dataset.sessionId === id) return;
        host.replaceChildren(); host.dataset.sessionId = id ?? '';
        if (id && this.options.openChild) this.button(host, 'flow.invoke.openSession', async () => {await this.options.openChild!(id);});
    }

    private updateActions(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task, control = invocationControl(snapshot), key = JSON.stringify([call.executionSessionId, control.actionsKey]);
        if (card.actionsKey === key) return;
        card.actionsKey = key;
        const actions = card.element.querySelector<HTMLElement>('[data-actions]')!; actions.replaceChildren();
        this.button(actions, 'flow.invoke.details', () => this.details(call));
        if (terminal(task.status)) this.button(actions, 'flow.invoke.repeat', () => this.repeat(call));
        else {
            this.button(actions, 'flow.invoke.cancel', async () => {await this.runControl(call, 'cancel', task.control?.epoch ?? 0);});
            if (control.canReattach) this.button(actions, 'flow.invoke.reattach', () => this.control(call, FlowCommand.RunResume));
            if (control.canRelease) this.button(actions, releaseLabel(control), () => this.setPaused(call, false, task.control!.epoch));
            else if (control.canWithdraw) this.button(actions, 'flow.invoke.withdrawPause', () => this.withdrawPause(call, task.control!.epoch));
            else if (canRequestPause(control)) this.button(actions, 'flow.invoke.pause', () => this.setPaused(call, true, task.control?.epoch ?? 0));
        }
        if (task.status === 'succeeded') this.button(actions, 'flow.invoke.use', async () => {
            const text = card.result ?? '';
            this.useResult(`${call.flow.name}\n${text}`);
        });
    }

    private async setPaused(call: FlowInvocationRecord, paused: boolean, expectedEpoch: number): Promise<void> {
        const result = await this.runControl(call, paused ? 'pause' : 'resume', expectedEpoch);
        this.recordRecovery(call, result);
    }

    private runControl(call: FlowInvocationRecord, action: 'pause' | 'resume' | 'withdraw' | 'cancel', epoch: number): Promise<PauseResult | undefined> {
        const signal = this.viewAbort.signal;
        return new FlowRunControl(this.commands, call.executionSessionId ?? this.sessionId, this.controlOperations).execute(call.rootTaskId!, action, epoch,
            () => !this.abort.signal.aborted && !signal.aborted && this.visible);
    }

    private recordRecovery(call: FlowInvocationRecord, result?: PauseResult): void {
        const card = this.cards.get(call.requestId);
        if (!card || this.abort.signal.aborted || !this.visible) return;
        card.recoveryNotice = result?.limitedRecovery && result.retainedTaskIds?.length
            ? t('flow.invoke.legacyRetained', {count: result.retainedTaskIds.length}) : undefined;
    }

    private async withdrawPause(call: FlowInvocationRecord, expectedEpoch: number): Promise<void> {
        await this.runControl(call, 'withdraw', expectedEpoch);
    }

    private updateControlRecovery(card: Card, call: FlowInvocationRecord): void {
        const host = card.element.querySelector<HTMLElement>('[data-control-recovery]')!;
        host.replaceChildren();
        for (const record of this.controlOperations.pending(call.rootTaskId!, call.executionSessionId ?? this.sessionId)) {
            const row = document.createElement('div'); host.append(row);
            const action = (record.input as {action: string}).action;
            row.append(t(action === 'cancel' ? 'flow.invoke.cancel' : action === 'pause' ? 'flow.invoke.pause' : action === 'resume' ? 'flow.invoke.continue' : 'flow.invoke.withdrawPause') + ' · ');
            const button = this.button(row, 'flow.invoke.reconcileControl', async () => {await this.controlOperations.reconcile(record.context.operationId);});
            button.dataset.controlReconcile = record.context.operationId;
        }
    }

    private updateInteractions(card: Card, call: FlowInvocationRecord, tasks: TaskRecord[]): void {
        const current = new Set<string>(), container = card.element.querySelector<HTMLElement>('[data-interactions]')!;
        for (const task of tasks.filter(item => !terminal(item.status))) for (const request of Object.values(task.interactions ?? {})) {
            if (request.status !== 'pending') continue;
            const key = `${task.id}/${request.id}`; current.add(key);
            if (card.interactions.has(key)) continue;
            const respond = async (value: JsonValue) => {
                const signal = this.viewAbort.signal;
                if (this.abort.signal.aborted || signal.aborted || !this.visible) throw new Error('Invocation view closed');
                const fresh = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { sessionId: call.executionSessionId ?? this.sessionId, taskId: call.rootTaskId });
                if (this.abort.signal.aborted || signal.aborted || !this.visible) throw new Error('Invocation view closed');
                assertCallScope(call, fresh);
                const target = invocationControlTasks(fresh).find(item => item.id === task.id);
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
                await promptFlowParameters(fields, request.prompt, respond, this.viewAbort.signal, undefined, flowInputAssets(this.commands));
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
            if (this.abort.signal.aborted || !this.visible) return;
            const area = parent.closest('article')?.querySelector('[data-error]'); if (area) area.textContent = String(error);
        }).finally(() => { this.actions.delete(actionId); if (this.abort.signal.aborted || !this.visible) return; button.disabled = false; this.renderInvocationRecovery(); void this.refresh(); }); });
        parent.append(button); return button;
    }

    private async control(call: FlowInvocationRecord, command: string): Promise<void> {
        const signal = this.viewAbort.signal;
        const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { taskId: call.rootTaskId, sessionId: call.executionSessionId ?? this.sessionId });
        assertCallScope(call, snapshot);
        if (this.abort.signal.aborted || signal.aborted || !this.visible) return;
        await this.commands.execute(command, { taskId: call.rootTaskId, sessionId: call.executionSessionId ?? this.sessionId });
    }

    private async repeat(call: FlowInvocationRecord): Promise<void> {
        const connection = await flowConnectionSelection(this.commands, call.connectionId, call.flow.connections, call.connectionBindings, call.flow);
        const parameters = call.inputResolution?.parameters ?? call.parameters;
        const fields = (call.flow.parameters ?? []).map(field => ({ ...field, ...(Object.hasOwn(parameters, field.name) ? { default: parameters[field.name] } : {}) }));
        await promptInvocation({commands: this.commands, sessionId: this.sessionId, name: call.flow.name, fields, connection,
            retryOf: {invocationId: flowInvocationId(call), sessionId: call.sessionId},
            signal: this.viewAbort.signal, revision: async () => call.flow, openChild: this.options.openChild, operations: this.operations});
    }

    private async details(call: FlowInvocationRecord): Promise<void> {
        openSessionFlowOutputs(this.commands, call.executionSessionId ?? this.sessionId, this.viewAbort.signal, call.rootTaskId);
    }
}

function olderSnapshot(next: DurableFlowSnapshot, previous?: DurableFlowSnapshot): boolean {
    if (!previous) return false;
    const records = new Map([...previous.taskTree, previous.root.task].map(task => [task.id, task]));
    return [next.root.task, ...next.taskTree].some(task => olderRevision(task.version, records.get(task.id)?.version)
        || olderRevision(task.control?.epoch, records.get(task.id)?.control?.epoch));
}

function olderRevision(next?: number, previous?: number): boolean {
    return Number.isSafeInteger(next) && Number.isSafeInteger(previous) && next! < previous!;
}

function controlStatusText(control: InvocationControl, label: string): string {
    const status = t(`flow.invoke.${label}` as Parameters<typeof t>[0]);
    return !control.terminal && control.externalHold && control.state !== 'constrained'
        ? `${status} · ${t('flow.invoke.constrained')}` : status;
}

function controlNotice(control: InvocationControl, recovery?: string): string {
    if (control.terminal || control.supportsPause) return '';
    return [t('flow.invoke.legacyPause'), recovery].filter(Boolean).join(' ');
}

function releaseLabel(control: InvocationControl): Parameters<typeof t>[0] {
    if (!control.supportsPause) return 'flow.invoke.legacyResume';
    return control.externalHold ? 'flow.invoke.releasePause' : 'flow.invoke.continue';
}

function canRequestPause(control: InvocationControl): boolean {
    return control.supportsPause && ['active', 'constrained'].includes(control.state);
}

function assertCallScope(call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
    if (call.executionSessionId && (snapshot.root.task.sessionId !== call.executionSessionId || snapshot.root.task.id !== call.rootTaskId))
        throw Object.assign(new Error('Flow execution does not belong to the saved child Session'), {code: 'FLOW_INVOCATION_EXECUTION_SCOPE'});
}
