import {IndependentCallControl} from './IndependentCallControl';
import {CallCancellationOperations, callCancellationProtocol} from '../independent/call-cancellation';
import {TaskArtifactBrowser} from './dag/TaskArtifactBrowser';
import {createModuleLogger, t} from '@itookit/common';
import type {OperationLedger} from '@itookit/llm-ui';
import {IndependentCallCommand, type IndependentCallView, type ICommandBus} from '@itookit/llm-session/contracts';
import {canonicalJson} from '../utils/canonical-json';

const log = createModuleLogger('independent-calls');
interface Card {element: HTMLElement; control: IndependentCallControl; artifacts: TaskArtifactBrowser; artifactScope?: string; release?: () => void}
interface Options {
    operations: OperationLedger;
    branch(): string;
    mountCard?(element: HTMLElement, call: IndependentCallView): () => void;
    openChild?(id: string): void | Promise<void>;
}

/** Reads host-owned call facts; never owns execution state or dispatches input. */
export class IndependentCallPanel {
    private cards = new Map<string, Card>();
    private element = document.createElement('section');
    private error = document.createElement('p');
    private abort = new AbortController();
    private visible = true;
    private generation = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private refreshing?: Promise<void>;
    private active = false;
    private releaseLedger: () => void;
    private readonly controls: CallCancellationOperations;
    constructor(private commands: ICommandBus, private sessionId: string, parent: HTMLElement, private options: Options) {
        this.controls = new CallCancellationOperations(options.operations, commands, sessionId);
        this.element.className = 'flow-invocations'; this.element.hidden = true;
        this.error.setAttribute('role', 'alert'); this.element.append(this.error); parent.append(this.element);
        this.releaseLedger = options.operations.subscribe(() => {void this.refresh();});
        const refresh = () => {if (!document.hidden) void this.refresh();};
        window.addEventListener('focus', refresh, {signal: this.abort.signal});
        document.addEventListener('visibilitychange', refresh, {signal: this.abort.signal});
        void this.refresh();
    }
    refresh(): Promise<void> {
        if (!this.visible || this.abort.signal.aborted) return Promise.resolve();
        if (this.refreshing) return this.refreshing;
        const generation = this.generation, branch = this.options.branch(), started = Date.now();
        const current = () => this.visible && !this.abort.signal.aborted && generation === this.generation && branch === this.options.branch();
        const operation = this.load(branch, current).catch(error => {
            if (!current()) return;
            this.active = true; this.element.hidden = false;
            const supplied = (error as {code?: unknown})?.code;
            const code = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied : 'CALL_VIEW_READ_FAILED';
            this.error.textContent = t('callable.independent.readFailed', {code});
            log.warn('call.list', {stage: 'projection', result: 'failure', durationMs: Date.now() - started,
                code});
        }).finally(() => {
            if (this.refreshing !== operation) return;
            this.refreshing = undefined; clearTimeout(this.timer);
            if (this.visible && !this.abort.signal.aborted) this.timer = setTimeout(() => {void this.refresh();},
                generation !== this.generation ? 0 : this.active || this.pending() ? 1000 : 30_000);
        });
        this.refreshing = operation; return operation;
    }
    reset(): void {++this.generation; this.refreshing = undefined; this.clearCards(); void this.refresh();}
    setVisible(value: boolean): void {
        this.visible = value; ++this.generation; this.refreshing = undefined; clearTimeout(this.timer);
        for (const card of this.cards.values()) {card.artifacts.setVisible(value); card.control.setActive(value);}
        if (value) void this.refresh();
    }
    destroy(): void {
        this.abort.abort(); ++this.generation; clearTimeout(this.timer); this.releaseLedger(); this.clearCards(); this.element.remove();
    }
    private pending(): boolean {
        return this.options.operations.getSnapshot().some(record => record.conversationId === this.sessionId && ['submitting', 'unknown'].includes(record.status)
            && (record.kind === 'send' && !!(record.input as {independentTitle?: string}).independentTitle
                || record.kind === 'command' && (record.input as {protocol?: string})?.protocol === callCancellationProtocol));
    }
    private async load(branch: string, current: () => boolean): Promise<void> {
        const calls = await this.commands.execute<IndependentCallView[]>(IndependentCallCommand.List, {sessionId: this.sessionId, branchId: branch});
        if (!current()) return;
        for (const call of calls) this.assertScope(call, branch);
        this.error.textContent = ''; this.element.hidden = !calls.length; this.active = false;
        for (const call of calls) {
            await this.reconcile(call);
            if (!current()) return;
            this.render(call);
            this.active ||= !call.status || !['completed', 'failed', 'cancelled'].includes(call.status)
                || !!call.executionState && !call.executionState.settled;
        }
        const ids = new Set(calls.map(call => call.receipt.operationId));
        for (const [id, card] of this.cards) if (!ids.has(id)) {this.disposeCard(card); this.cards.delete(id);}
    }
    private assertScope(call: IndependentCallView, branch: string): void {
        const {request} = call.input, receipt = call.receipt;
        if (request.expectedSessionId !== this.sessionId || request.expectedBranch !== branch || receipt.callerSessionId !== this.sessionId
            || receipt.operationId !== request.submission?.id || !['accepted', 'unknown'].includes(receipt.status)
            || receipt.executionSessionId === this.sessionId || receipt.status === 'accepted' && !receipt.executionSessionId
            || call.executionState && call.executionState.id !== receipt.execution?.taskId
            || receipt.execution && (receipt.execution.role !== 'primary' || typeof receipt.execution.taskId !== 'string' || !receipt.execution.taskId))
            throw Object.assign(new Error('CALL_VIEW_SCOPE_MISMATCH'), {code: 'CALL_VIEW_SCOPE_MISMATCH'});
    }
    private async reconcile(call: IndependentCallView): Promise<void> {
        if (call.receipt.status !== 'accepted' || call.input.transfer) return;
        const record = this.options.operations.getSnapshot().find(record => record.context.operationId === call.receipt.operationId
            && record.conversationId === this.sessionId && record.kind === 'send' && ['submitting', 'unknown'].includes(record.status));
        if (!record) return;
        const frozen = record.input as {request?: unknown; sessionRequest?: unknown; independentTitle?: string};
        if (frozen.independentTitle !== call.input.title || canonicalJson(frozen.request ?? frozen.sessionRequest) !== canonicalJson(call.input.request)) return;
        await this.options.operations.settle({operationId: call.receipt.operationId, status: 'accepted'});
    }
    private render(call: IndependentCallView): void {
        const id = call.receipt.operationId;
        let card = this.cards.get(id);
        if (!card) {
            const element = document.createElement('article'); element.className = 'flow-invocations__card'; element.dataset.independentCall = id;
            element.innerHTML = '<header><strong></strong><span role="status"></span></header><details><summary></summary><pre data-input></pre></details><p data-execution-state role="status"></p><p data-preview-label></p><pre data-output></pre><button type="button" data-open-child></button><div data-artifacts></div><div data-call-control></div>';
            card = {element, control: new IndependentCallControl(element.querySelector('[data-call-control]')!, this.controls, () => {void this.refresh();}),
                artifacts: new TaskArtifactBrowser(element, this.commands), release: this.options.mountCard?.(element, call)};
            if (!this.options.mountCard) this.element.append(element);
            this.cards.set(id, card);
        }
        const element = card.element;
        element.querySelector('strong')!.textContent = call.input.title;
        element.querySelector('summary')!.textContent = t('flow.invoke.inputs');
        element.querySelector('[data-input]')!.textContent = JSON.stringify(call.input.request.source, null, 2);
        element.querySelector('[role=status]')!.textContent = statusText(call);
        element.querySelector('[data-execution-state]')!.textContent = executionStateText(call);
        element.querySelector('[data-preview-label]')!.textContent = t('callable.independent.preview');
        element.querySelector('[data-output]')!.textContent = call.summary ?? '';
        const button = element.querySelector<HTMLButtonElement>('[data-open-child]')!; button.textContent = t('flow.invoke.openSession'); button.hidden = !call.receipt.executionSessionId || !this.options.openChild;
        button.onclick = () => {void this.open(call.receipt.executionSessionId!);};
        this.renderArtifacts(card, call); card.control.update(call);
    }
    private renderArtifacts(card: Card, call: IndependentCallView): void {
        const {executionSessionId, execution, status} = call.receipt;
        const scope = status === 'accepted' && executionSessionId && execution && call.status
            && ['completed', 'failed', 'cancelled'].includes(call.status) ? {sessionId: executionSessionId, taskId: execution.taskId} : undefined;
        const key = scope && JSON.stringify(scope);
        if (key === card.artifactScope) return;
        card.artifacts.clear(); card.artifactScope = key;
        card.element.querySelector('[data-artifacts]')!.innerHTML = scope ? card.artifacts.render(scope) : '';
    }
    private disposeCard(card: Card): void {card.control.destroy(); card.artifacts.dispose(); card.release?.(); card.element.remove();}
    private async open(id: string): Promise<void> {
        if (!this.visible || this.abort.signal.aborted) return;
        try {await this.options.openChild?.(id);}
        catch {if (!this.abort.signal.aborted) {this.element.hidden = false; this.error.textContent = t('callable.independent.openFailed');}}
    }
    private clearCards(): void {for (const card of this.cards.values()) this.disposeCard(card); this.cards.clear();}
}
function statusText(call: IndependentCallView): string {
    const state = call.status ?? (call.receipt.status === 'accepted' ? 'pending' : 'unknown');
    return t(`callable.independent.status.${state}`);
}

function executionStateText(call: IndependentCallView): string {
    const state = call.executionState;
    if (!state) return '';
    if (state.phase === 'done') return state.settled ? '' : t('callable.independent.execution.cleaning', {count: state.activeOperations});
    if (state.control.requested === 'pause') return t(state.stopped ? 'callable.independent.execution.paused' : 'callable.independent.execution.pausing');
    if (state.control.requested === 'interrupt') return t(state.stopped ? 'callable.independent.execution.interrupted' : 'callable.independent.execution.interrupting');
    if (state.blockedBy === 'session-control' || state.blockedBy === 'ancestor-control') return t('callable.independent.execution.held');
    return '';
}
