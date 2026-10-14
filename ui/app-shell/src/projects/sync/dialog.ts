import { t } from '@itookit/common';

/** Closing a view never cancels a command already submitted to the server. */
export class SyncDialog {
    readonly body = document.createElement('div');
    readonly actions = document.createElement('div');
    private readonly dialog = document.createElement('dialog');
    private readonly status = document.createElement('p');
    private busy = false;
    private closed = false;
    constructor(title: string, private readonly signal: AbortSignal, private readonly onClose: () => void = () => {}) {
        this.dialog.className = 'project-dialog project-sync-dialog'; this.dialog.setAttribute('aria-label', title);
        const heading = document.createElement('h2'); heading.textContent = title;
        this.status.setAttribute('role', 'status'); this.actions.className = 'project-dialog__actions';
        this.dialog.append(heading, this.body, this.status, this.actions);
        const cancel = this.button(t('project.cancel'), async () => this.close());
        cancel.dataset.closeControl = 'true'; cancel.onclick = this.close;
        this.dialog.oncancel = event => { event.preventDefault(); this.close(); };
    }
    button(label: string, action: () => Promise<void>, allowClose = false): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = () => { void this.run(action, allowClose); }; this.actions.append(button); return button;
    }
    async run(action: () => Promise<void>, allowClose = false): Promise<void> {
        if (this.busy || this.signal.aborted || !this.dialog.isConnected) return;
        this.busy = true; this.status.textContent = t('project.sync.working');
        this.setDisabled(true, allowClose);
        try { await action(); } catch (error) { this.message(error instanceof Error ? error.message : String(error)); }
        finally { this.busy = false; this.setDisabled(false); }
    }
    message(text: string): void { this.status.textContent = text; }
    open(): void {
        if (this.signal.aborted) return;
        document.body.append(this.dialog); this.dialog.showModal(); this.signal.addEventListener('abort', this.close, { once: true });
    }
    close = (): void => {
        if (this.closed) return;
        this.closed = true;
        this.signal.removeEventListener('abort', this.close); this.dialog.close(); this.dialog.remove();
        this.onClose();
    };
    private setDisabled(disabled: boolean, allowClose = false): void {
        for (const input of this.dialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button, select, input')) {
            input.disabled = (disabled && !(allowClose && input.dataset.closeControl === 'true')) || input.dataset.unavailable === 'true';
        }
    }
}
export function paragraph(container: HTMLElement, text: string): void {
    const element = document.createElement('p'); element.textContent = text; container.append(element);
}
