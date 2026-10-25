import {IndependentCallStateControl} from './IndependentCallStateControl';
import {randomUUID, t} from '@itookit/common';
import type {IndependentCallView, IndependentCallDescendant} from '@itookit/llm-session/contracts';
import {CallControlOperations, callControlErrorCode} from '../independent/call-control';

/** Buttons own view lifecycle only; durable admission remains in the shared operation ledger. */
export class IndependentCallControl {
    private remaining?: IndependentCallControl;
    private state?: IndependentCallStateControl;
    private target?: IndependentCallDescendant;
    private call?: IndependentCallView;
    private active = true;
    private closed = false;
    private dispatching = false;
    private reading = false;
    private generation = 0;
    private error = '';
    private readonly button = document.createElement('button');
    private readonly status = document.createElement('p');
    constructor(private element: HTMLElement, private controls: CallControlOperations, private refresh: () => void, private targetTaskId?: string, private readonly mode: 'cancel' | 'remaining' = 'cancel') {
        this.button.type = 'button'; this.status.setAttribute('role', 'status');
        if (mode === 'remaining') this.button.dataset.callCancelRemaining = '';
        else this.button.dataset.callCancel = '';
        const state = document.createElement('div'), remaining = document.createElement('div');
        if (!targetTaskId && mode === 'cancel') {
            this.state = new IndependentCallStateControl(state, controls, refresh);
            this.remaining = new IndependentCallControl(remaining, controls, refresh, undefined, 'remaining');
        } else if (targetTaskId) this.button.dataset.callCancelTarget = targetTaskId;
        this.element.append(this.button, this.status, state, remaining);
        this.button.onclick = () => {void this.act();};
    }
    update(call: IndependentCallView, target?: IndependentCallDescendant): void {
        this.call = call; this.target = target; this.state?.update(call); this.remaining?.update(call); this.render();
        if (this.pending() && this.active && !this.closed && !this.reading) void this.read();
    }
    setActive(active: boolean): void {this.state?.setActive(active); this.remaining?.setActive(active);this.active = active; ++this.generation; this.reading = false; this.render();}
    destroy(): void {this.state?.destroy(); this.remaining?.destroy();this.closed = true; this.setActive(false); this.button.onclick = null; this.element.replaceChildren();}
    private record() {
        const call = this.call;
        return call?.receipt.execution && this.controls.latest(call.input.request.expectedBranch!, call.receipt.operationId, call.receipt.execution.taskId, this.mode, this.targetTaskId);
    }
    private pending() {const record = this.record(); return record && ['submitting', 'unknown'].includes(record.status) ? record : undefined;}
    private render(): void {
        const pending = this.pending(), accepted = this.record()?.status === 'accepted';
        const canCancel = this.canCancel();
        this.element.hidden = false;
        this.button.hidden = !pending && (!canCancel || accepted);
        this.button.textContent = t(pending ? 'callable.independent.cancel.query' : this.mode === 'remaining' ? 'callable.independent.cancelRemaining.action' : this.targetTaskId ? 'callable.independent.descendants.cancel' : 'callable.independent.cancel.action');
        this.button.disabled = !this.active || this.closed || (pending ? this.reading : this.dispatching);
        this.status.textContent = accepted ? t(this.mode === 'remaining' ? 'callable.independent.cancelRemaining.accepted' : 'callable.independent.cancel.accepted') : this.error || (pending ? t('callable.independent.cancel.unknown') : '');
    }
    private execution() {return this.targetTaskId ? this.target?.executionState : this.call?.executionState;}
    private canCancel(): boolean {
        if (this.mode === 'remaining') return !!this.call?.controlCapabilities?.cancelRemaining
            && this.call.executionState?.phase === 'done' && this.call.executionTree?.settled === false && this.call.receipt.status === 'accepted';
        const supported = this.targetTaskId ? this.target?.taskId === this.targetTaskId && this.target.cancel : this.call?.controlCapabilities?.cancel;
        const state = this.execution();
        return !!supported && !!state && state.phase !== 'done' && this.call?.receipt.status === 'accepted';
    }
    private async act(): Promise<void> {
        if (!this.active || this.closed) return;
        if (this.pending()) return this.read();
        const call = this.call;
        if (this.dispatching || !call || !this.canCancel() || this.record()?.status === 'accepted') return;
        const generation = this.generation; this.dispatching = true; this.error = ''; this.render();
        const request = {sessionId: call.receipt.callerSessionId, branchId: call.input.request.expectedBranch!, callId: call.receipt.operationId,
            executionSessionId: call.receipt.executionSessionId!, taskId: call.receipt.execution!.taskId,
            requestId: randomUUID(), expectedEpoch: this.execution()!.controlEpoch, ...(this.targetTaskId ? {targetTaskId: this.targetTaskId} : {})};
        try {await (this.mode === 'remaining' ? this.controls.cancelRemaining.bind(this.controls) : this.controls.cancel.bind(this.controls))(request, () => this.active && !this.closed && generation === this.generation);}
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
