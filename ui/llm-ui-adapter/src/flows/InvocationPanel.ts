import {flowInputAssets} from './input-assets';
import { promptInvocation } from './prompt-invocation';
import { flowConnectionSelection } from './connection-selection';
import { createModuleLogger, escapeHTML, randomUUID, t } from '@itookit/common';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { type FlowParameter, type JsonValue } from '@itookit/llm-flow/contracts';
import { formatFlowOutput } from '@itookit/llm-flow/contracts';
import { FlowInvocationCommand, flowInvocationId, type FlowInvocationRecord } from '@itookit/llm-session/contracts';
import { FlowCommand, type DurableFlowSnapshot } from '@itookit/llm-flow/contracts';
import type { InteractionRequest, TaskRecord } from '@itookit/durable-kernel/contracts';
import { InteractionPanel } from '../components/input/InteractionPanel';
import { promptFlowParameters } from '../components/FlowParameterForm';
import { DagWorkbench } from '../components/DagWorkbench';
import { inputInteraction } from '../shell/input-interaction';
import {invocationControl, invocationControlTasks, invocationStatus, type InvocationControl} from './invocation-control';

const terminal = (status: string) => ['succeeded', 'failed', 'cancelled'].includes(status);
const log = createModuleLogger('invocation-control');
interface Card { element: HTMLElement; interactions: Map<string, InteractionPanel | HTMLElement>; snapshot?: DurableFlowSnapshot; active: boolean; actionsKey?: string; loadError?: boolean; recoveryNotice?: string; unmount?: () => void }
interface PauseResult {limitedRecovery?: true; retainedTaskIds?: string[]}

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
    private controlRequests = new Map<string, string>();
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
        this.cards.clear(); this.controlRequests.clear(); this.element.remove();
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
            try {await this.readCard(card, call);}
            catch (error) { failed = true; failure = error; card.loadError = true; card.element.querySelector('[data-error]')!.textContent = t('flow.invoke.refreshFailed', {reason: String(error)}); }
        }
        this.updateSummary();
        if (failed) throw failure;
    }

    private async readCard(card: Card, call: FlowInvocationRecord): Promise<void> {
        const snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {sessionId: this.sessionId, taskId: call.rootTaskId});
        if (this.abort.signal.aborted || !this.visible || olderSnapshot(snapshot, card.snapshot)) return;
        if (card.loadError) {card.element.querySelector('[data-error]')!.textContent = ''; card.loadError = false;}
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
            <details><summary>${escapeHTML(t('flow.invoke.inputs'))}</summary>${this.inputSources(call)}<pre>${escapeHTML(JSON.stringify(call.inputResolution?.parameters ?? call.parameters, null, 2))}</pre></details>
            <p data-control-notice role="status"></p><div data-actions></div><details><summary>${escapeHTML(t('flow.invoke.result'))}</summary><pre data-result></pre></details><div data-interactions></div><p data-error role="alert"></p>`;
        const unmount = this.options.mountCard?.(element, call);
        if (!this.options.mountCard) this.element.append(element);
        return { element, interactions: new Map(), active: !call.error, unmount };
    }

    private updateCard(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task;
        card.active = !terminal(task.status);
        const control = invocationControl(snapshot), label = invocationStatus(snapshot, control);
        card.element.querySelector('[data-status]')!.textContent = controlStatusText(control, label);
        card.element.querySelector('[data-control-notice]')!.textContent = controlNotice(control, card.recoveryNotice);
        const returned = (task.output as { nodes?: Record<string, unknown> } | undefined)?.nodes?.__flow_return;
        const result = formatFlowOutput(returned ?? task.output ?? task.exit?.error ?? task.lastError ?? '');
        card.element.querySelector('[data-result]')!.textContent = result;
        this.updateActions(card, call, snapshot);
        this.updateInteractions(card, call, terminal(task.status) ? [] : invocationControlTasks(snapshot));
    }

    private inputSources(call: FlowInvocationRecord): string {
        return Object.entries(call.inputTransfers ?? {}).map(([name, transfer]) => `<p>${escapeHTML(t('flow.invoke.source', {
            name, kind: [t(`flow.source.${transfer.selection.kind}` as Parameters<typeof t>[0]), transfer.output?.label].filter(Boolean).join(' · '), count: transfer.messageIds.length,
        }))}</p>`).join('');
    }

    private updateActions(card: Card, call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): void {
        const task = snapshot.root.task, control = invocationControl(snapshot), key = control.actionsKey;
        if (card.actionsKey === key) return;
        card.actionsKey = key;
        const actions = card.element.querySelector<HTMLElement>('[data-actions]')!; actions.replaceChildren();
        this.button(actions, 'flow.invoke.details', () => this.details(call.rootTaskId!));
        if (terminal(task.status)) this.button(actions, 'flow.invoke.repeat', () => this.repeat(call));
        else {
            this.button(actions, 'flow.invoke.cancel', () => this.control(call, FlowCommand.RunCancel));
            if (control.canReattach) this.button(actions, 'flow.invoke.reattach', () => this.control(call, FlowCommand.RunResume));
            if (control.canRelease) this.button(actions, releaseLabel(control), () => this.setPaused(call, false, task.control!.epoch));
            else if (control.canWithdraw) this.button(actions, 'flow.invoke.withdrawPause', () => this.withdrawPause(call, task.control!.epoch));
            else if (canRequestPause(control)) this.button(actions, 'flow.invoke.pause', () => this.setPaused(call, true, task.control?.epoch ?? 0));
        }
        if (task.status === 'succeeded') this.button(actions, 'flow.invoke.use', async () => {
            const text = card.element.querySelector('[data-result]')!.textContent ?? '';
            this.useResult(`${call.flow.name}\n${text}`);
        });
    }

    private async setPaused(call: FlowInvocationRecord, paused: boolean, expectedEpoch: number): Promise<void> {
        const requestId = this.controlRequest(`${call.rootTaskId}:${paused ? 'pause' : 'resume'}:${expectedEpoch}`), started = Date.now();
        try {if (await this.changePause(call, paused, expectedEpoch, requestId)) controlDiagnostic(paused ? 'pause' : 'resume', requestId, started);}
        catch (error) {controlDiagnostic(paused ? 'pause' : 'resume', requestId, started, error); throw error;}
    }

    private async changePause(call: FlowInvocationRecord, paused: boolean, expectedEpoch: number, requestId: string): Promise<boolean> {
        const signal = this.viewAbort.signal;
        let snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {taskId: call.rootTaskId, sessionId: this.sessionId});
        if (terminal(snapshot.root.task.status)) throw new Error(t('flow.rerun.unavailable'));
        if (this.abort.signal.aborted || signal.aborted || !this.visible) return false;
        assertControlEpoch(snapshot, expectedEpoch);
        if (paused && !invocationControl(snapshot).supportsPause) throw new Error(t('flow.invoke.legacyPause'));
        if (!paused) snapshot = await this.prepareRelease(call, snapshot);
        if (this.abort.signal.aborted || signal.aborted || !this.visible) return false;
        assertControlEpoch(snapshot, expectedEpoch);
        const result = await this.commands.execute<PauseResult>(FlowCommand.RunGoalUpdate, {taskId: call.rootTaskId, requestId, expectedEpoch, goal: {status: paused ? 'paused' : 'active'}});
        this.recordRecovery(call, result);
        return true;
    }

    private recordRecovery(call: FlowInvocationRecord, result?: PauseResult): void {
        const card = this.cards.get(call.requestId);
        if (!card || this.abort.signal.aborted || !this.visible) return;
        card.recoveryNotice = result?.limitedRecovery && result.retainedTaskIds?.length
            ? t('flow.invoke.legacyRetained', {count: result.retainedTaskIds.length}) : undefined;
    }

    private async prepareRelease(call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): Promise<DurableFlowSnapshot> {
        if (!invocationControl(snapshot).canRelease) throw new Error(t('flow.invoke.pauseUnconfirmed'));
        const fresh = await this.reattachPaused(call, snapshot);
        if (!invocationControl(fresh).canRelease) throw new Error(t('flow.invoke.pauseUnconfirmed'));
        return fresh;
    }

    private async reattachPaused(call: FlowInvocationRecord, snapshot: DurableFlowSnapshot): Promise<DurableFlowSnapshot> {
        if (!snapshot.attachedFromStorage || invocationControl(snapshot).externalHold) return snapshot;
        await this.commands.execute(FlowCommand.RunResume, {taskId: call.rootTaskId, sessionId: this.sessionId});
        return this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {taskId: call.rootTaskId, sessionId: this.sessionId});
    }

    private async withdrawPause(call: FlowInvocationRecord, expectedEpoch: number): Promise<void> {
        const signal = this.viewAbort.signal;
        const requestId = this.controlRequest(`${call.rootTaskId}:withdraw:${expectedEpoch}`), started = Date.now();
        try {
            let snapshot = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {taskId: call.rootTaskId, sessionId: this.sessionId});
            if (this.abort.signal.aborted || signal.aborted || !this.visible) return;
            assertWithdraw(snapshot, expectedEpoch); snapshot = await this.reattachPaused(call, snapshot);
            if (this.abort.signal.aborted || signal.aborted || !this.visible) return;
            assertWithdraw(snapshot, expectedEpoch);
            await this.commands.execute(FlowCommand.RunPauseWithdraw, {taskId: call.rootTaskId, requestId, expectedEpoch});
            controlDiagnostic('withdraw', requestId, started);
        } catch (error) {controlDiagnostic('withdraw', requestId, started, error); throw error;}
    }

    private controlRequest(key: string): string {
        const requestId = this.controlRequests.get(key) ?? randomUUID(); this.controlRequests.set(key, requestId); return requestId;
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
                const fresh = await this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, { sessionId: this.sessionId, taskId: call.rootTaskId });
                if (this.abort.signal.aborted || signal.aborted || !this.visible) throw new Error('Invocation view closed');
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
        }).finally(() => { this.actions.delete(actionId); if (this.abort.signal.aborted || !this.visible) return; button.disabled = false; void this.refresh(); }); });
        parent.append(button); return button;
    }

    private async control(call: FlowInvocationRecord, command: string): Promise<void> {
        const signal = this.viewAbort.signal;
        await this.commands.execute(FlowCommand.RunGet, { taskId: call.rootTaskId, sessionId: this.sessionId });
        if (this.abort.signal.aborted || signal.aborted || !this.visible) return;
        await this.commands.execute(command, { taskId: call.rootTaskId, sessionId: this.sessionId });
    }

    private async repeat(call: FlowInvocationRecord): Promise<void> {
        const connection = await flowConnectionSelection(this.commands, call.connectionId, call.flow.connections, call.connectionBindings, call.flow);
        const parameters = call.inputResolution?.parameters ?? call.parameters;
        const fields = (call.flow.parameters ?? []).map(field => ({ ...field, ...(Object.hasOwn(parameters, field.name) ? { default: parameters[field.name] } : {}) }));
        await promptInvocation({commands: this.commands, sessionId: this.sessionId, name: call.flow.name, fields, connection,
            retryOf: {invocationId: flowInvocationId(call), sessionId: call.sessionId},
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

function assertWithdraw(snapshot: DurableFlowSnapshot, expectedEpoch: number): void {
    if (!invocationControl(snapshot).canWithdraw || snapshot.root.task.control?.epoch !== expectedEpoch)
        throw Object.assign(new Error(t('flow.invoke.pauseChanged')), {code: 'FLOW_PAUSE_CHANGED'});
}

function assertControlEpoch(snapshot: DurableFlowSnapshot, expectedEpoch: number): void {
    if ((snapshot.root.task.control?.epoch ?? 0) !== expectedEpoch)
        throw Object.assign(new Error(t('flow.invoke.pauseChanged')), {code: 'FLOW_PAUSE_CHANGED'});
}

function controlDiagnostic(action: string, identity: string, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const data = {operation: `flow.control.${action}`, operationId: /^[\w:-]{1,256}$/.test(identity) ? identity : undefined,
        stage: 'control', result: error ? 'failure' : 'accepted', durationMs: Date.now() - started,
        ...(error ? {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_CONTROL_FAILED'} : {})};
    try {if (error) log.warn('Flow invocation control', data); else log.info('Flow invocation control', data);}
    catch { /* Diagnostics must not change a control result. */ }
}
