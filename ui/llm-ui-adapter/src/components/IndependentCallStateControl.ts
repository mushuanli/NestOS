import {randomUUID, t} from '@itookit/common';
import type {IndependentCallView, IndependentCallControlAction, IndependentCallStateControlRequest} from '@itookit/llm-session/contracts';
import {CallControlOperations, callControlErrorCode} from '../independent/call-control';

/** State controls never share the cancellation channel's pending lock. */
export class IndependentCallStateControl {
    private call?: IndependentCallView;
    private active = true;
    private closed = false;
    private sending?: string;
    private reading = false;
    private generation = 0;
    private error = '';
    private button = document.createElement('button');
    private status = document.createElement('p');
    constructor(private element: HTMLElement, private controls: CallControlOperations, private refresh: () => void) {
        this.button.type = 'button'; this.button.dataset.callStateControl = ''; this.status.setAttribute('role', 'status');
        element.append(this.button, this.status); this.button.onclick = () => {void this.act();};
    }
    update(call: IndependentCallView): void {
        this.call = call; this.render();
        if (this.pending() && this.active && !this.closed && !this.reading) void this.read();
    }
    setActive(active: boolean): void {this.active = active; ++this.generation; this.reading = false; this.render();}
    destroy(): void {this.closed = true; this.setActive(false); this.button.onclick = null; this.element.replaceChildren();}
    private record() {
        const call = this.call;
        return call?.receipt.execution && this.controls.latest(call.input.request.expectedBranch!, call.receipt.operationId, call.receipt.execution.taskId, 'state');
    }
    private pending() {const record = this.record(); return record && ['submitting', 'unknown'].includes(record.status) ? record : undefined;}
    private dispatching(): boolean {return !!this.sending && !(this.record()?.context.operationId === this.sending && this.record()?.status === 'accepted');}
    private action(): IndependentCallControlAction | undefined {
        const call = this.call, state = call?.executionState, capability = call?.controlCapabilities;
        if (!state || state.phase === 'done' || call?.receipt.status !== 'accepted') return;
        if (state.control.requested === 'pause') return state.control.acknowledged ? capability?.resume ? 'resume' : undefined : capability?.withdrawPause ? 'withdraw' : undefined;
        if (state.control.requested === 'run' && capability?.pause === 'boundary') return 'pause';
    }
    private render(): void {
        const pending = this.pending(), action = this.action(), record = this.record();
        const awaiting = record?.status === 'accepted' && ((record.input as unknown as {request: IndependentCallStateControlRequest}).request.expectedEpoch >= (this.call?.executionState?.controlEpoch ?? 0));
        this.element.hidden = !pending && !action && !this.error;
        this.button.hidden = !pending && !action;
        this.button.disabled = !this.active || this.closed || (pending ? this.reading : this.dispatching() || awaiting);
        this.button.textContent = t(pending ? 'callable.independent.control.query' : `callable.independent.control.${action ?? 'pause'}`);
        this.status.textContent = this.error || (pending ? t('callable.independent.control.unknown') : awaiting ? t('callable.independent.control.accepted') : '');
    }
    private async act(): Promise<void> {
        if (!this.active || this.closed) return;
        if (this.pending()) return this.read();
        const call = this.call, action = this.action();
        if (this.dispatching() || !call?.executionState || !action || this.button.disabled) return;
        const generation = this.generation, requestId = randomUUID(); this.sending = requestId; this.error = ''; this.render();
        const request = {sessionId: call.receipt.callerSessionId, branchId: call.input.request.expectedBranch!, callId: call.receipt.operationId,
            executionSessionId: call.receipt.executionSessionId!, taskId: call.receipt.execution!.taskId,
            requestId, expectedEpoch: call.executionState.controlEpoch, action};
        try {await this.controls.control(request, () => this.active && !this.closed && generation === this.generation);}
        catch (error) {if (!this.closed && generation === this.generation) this.fail(error);}
        finally {if (this.sending === requestId) this.sending = undefined; if (!this.closed && generation === this.generation) {this.render(); this.refresh();}}
    }
    private async read(): Promise<void> {
        const record = this.pending(); if (!record || this.reading || !this.active || this.closed) return;
        const generation = this.generation; this.reading = true; this.error = ''; this.render();
        try {await this.controls.reconcile(record.context.operationId);}
        catch (error) {if (!this.closed && generation === this.generation) this.fail(error);}
        finally {if (!this.closed && generation === this.generation) {this.reading = false; this.render();}}
    }
    private fail(error: unknown): void {
        const code = callControlErrorCode(error);
        this.error = t(code === 'CALL_CONTROL_SAVE_FAILED' ? 'callable.independent.control.saveFailed' : 'callable.independent.control.failed', {code});
    }
}
