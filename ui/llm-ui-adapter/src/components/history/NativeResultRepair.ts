import {t} from '@itookit/common';

type ResultError = {operationId: string; code: string};

/** Reconcile the original durable operation; this action never submits another command. */
export class NativeResultRepair {
    readonly element = document.createElement('div');
    private current?: ResultError;
    private disposed = false;
    private pending = false;
    private active = true;
    private error?: string;
    constructor(private readonly reconcile: (operationId: string) => Promise<unknown>) {this.element.className = 'native-result-repair';}
    update(current?: ResultError): void {this.current = current; this.render();}
    setActive(active: boolean): void {this.active = active;}
    destroy(): void {this.disposed = true; this.element.remove();}
    private render(): void {
        if (this.disposed) return;
        this.element.hidden = !this.current;
        this.element.replaceChildren(); if (!this.current) return;
        const button = document.createElement('button'); button.type = 'button'; button.dataset.reconcileResult = this.current.operationId;
        button.textContent = t('harness.reconcile'); button.disabled = this.pending;
        const operationId = this.current.operationId; button.onclick = () => {void this.read(operationId);}; this.element.append(button);
        if (this.error) {const error = document.createElement('span'); error.setAttribute('role', 'alert'); error.textContent = this.error; this.element.append(error);}
    }
    private async read(operationId: string): Promise<void> {
        if (!this.active || this.pending || this.disposed || this.current?.operationId !== operationId) return;
        this.pending = true; this.error = undefined; this.render();
        try {await this.reconcile(operationId);}
        catch (error) {
            const code = (error as {code?: unknown})?.code;
            if (!this.disposed && this.current?.operationId === operationId) this.error = t('harness.commandOutput.failed', {code:
                typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'COMMAND_RESULT_RECONCILE_FAILED'});
        } finally {this.pending = false; this.render();}
    }
}
