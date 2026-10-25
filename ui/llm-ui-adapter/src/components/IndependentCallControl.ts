import {IndependentCallStateControl} from './IndependentCallStateControl';
import {randomUUID, t} from '@itookit/common';
import type {IndependentCallView} from '@itookit/llm-session/contracts';
import {CallControlOperations, callControlErrorCode} from '../independent/call-control';

/** Buttons own view lifecycle only; durable admission remains in the shared operation ledger. */
export class IndependentCallControl {
    private state: IndependentCallStateControl;
    private call?: IndependentCallView;
    private active = true;
    private closed = false;
    private dispatching = false;
    private reading = false;
    private generation = 0;
    private error = '';
    private readonly button = document.createElement('button');
    private readonly status = document.createElement('p');
    constructor(private element: HTMLElement, private controls: CallControlOperations, private refresh: () => void) {
        this.button.type = 'button'; this.button.dataset.callCancel = ''; this.status.setAttribute('role', 'status');
        const state = document.createElement('div');
        this.state = new IndependentCallStateControl(state, controls, refresh);
        this.element.append(this.button, this.status, state);
        this.button.onclick = () => {void this.act();};
    }
    update(call: IndependentCallView): void {
        this.call = call; this.state.update(call); this.render();
        if (this.pending() && this.active && !this.closed && !this.reading) void this.read();
    }
    setActive(active: boolean): void {this.state.setActive(active);this.active = active; ++this.generation; this.reading = false; this.render();}
    destroy(): void {this.state.destroy();this.closed = true; this.setActive(false); this.button.onclick = null; this.element.replaceChildren();}
    private record() {
        const call = this.call;
        return call?.receipt.execution && this.controls.latest(call.input.request.expectedBranch!, call.receipt.operationId, call.receipt.execution.taskId);
    }
    private pending() {const record = this.record(); return record && ['submitting', 'unknown'].includes(record.status) ? record : undefined;}
    private render(): void {
        const call = this.call, pending = this.pending(), accepted = this.record()?.status === 'accepted';
        const canCancel = call?.controlCapabilities?.cancel && call.executionState && call.executionState.phase !== 'done' && call.receipt.status === 'accepted';
        this.element.hidden = false;
        this.button.hidden = !pending && (!canCancel || accepted);
        this.button.textContent = t(pending ? 'callable.independent.cancel.query' : 'callable.independent.cancel.action');
        this.button.disabled = !this.active || this.closed || (pending ? this.reading : this.dispatching);
        this.status.textContent = accepted ? t('callable.independent.cancel.accepted') : this.error || (pending ? t('callable.independent.cancel.unknown') : '');
    }
    private async act(): Promise<void> {
        if (!this.active || this.closed) return;
        if (this.pending()) return this.read();
        const call = this.call;
        if (this.dispatching || !call?.controlCapabilities?.cancel || !call.executionState || call.executionState.phase === 'done' || this.record()?.status === 'accepted') return;
        const generation = this.generation; this.dispatching = true; this.error = ''; this.render();
        const request = {sessionId: call.receipt.callerSessionId, branchId: call.input.request.expectedBranch!, callId: call.receipt.operationId,
            executionSessionId: call.receipt.executionSessionId!, taskId: call.receipt.execution!.taskId,
            requestId: randomUUID(), expectedEpoch: call.executionState.controlEpoch};
        try {await this.controls.cancel(request, () => this.active && !this.closed && generation === this.generation);}
        catch (error) {if (!this.closed && generation === this.generation) this.error = callControlErrorCode(error) === 'CALL_CONTROL_SAVE_FAILED' ? t('callable.independent.cancel.saveFailed')
            : t('callable.independent.cancel.failed', {code: callControlErrorCode(error)});}
        finally {this.dispatching = false; if (!this.closed && generation === this.generation) {this.render(); this.refresh();}}
    }
    private async read(): Promise<void> {
        const record = this.pending(); if (!record || this.reading || !this.active || this.closed) return;
        const generation = this.generation; this.reading = true; this.error = ''; this.render();
        try {await this.controls.reconcile(record.context.operationId);}
        catch (error) {if (!this.closed && generation === this.generation) this.error = callControlErrorCode(error) === 'CALL_CONTROL_SAVE_FAILED' ? t('callable.independent.cancel.saveFailed')
            : t('callable.independent.cancel.failed', {code: callControlErrorCode(error)});}
        finally {if (!this.closed && generation === this.generation) {this.reading = false; this.render();}}
    }
}
