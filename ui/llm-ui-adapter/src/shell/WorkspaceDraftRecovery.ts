import {t} from '@itookit/common';
import type {DraftConflict} from '../services/DraftPersistence';
interface DraftRecoveryPort {
    read(): DraftConflict | undefined;
    subscribe(listener: () => void): () => void;
    resolve(action: 'load' | 'replace'): Promise<void>;
}
/** Conflict decisions affect only the draft; they never submit or control an Invocation. */
export class WorkspaceDraftRecovery {
    private readonly element = document.createElement('div');
    private readonly release: () => void;
    private busy = false;
    private closed = false;
    private error?: string;
    constructor(host: HTMLElement, private readonly port: DraftRecoveryPort) {
        this.element.className = 'llm-input__connection-notice'; this.element.dataset.draftRecovery = '';
        this.element.setAttribute('role', 'status'); host.before(this.element);
        this.release = port.subscribe(() => this.refresh()); this.refresh();
    }
    refresh(): void {
        if (this.closed) return;
        const conflict = this.port.read(); this.element.hidden = !conflict; this.element.replaceChildren();
        if (!conflict) {this.error = undefined; return;}
        const label = document.createElement('span'); label.textContent = this.error ?? t('chatInput.draft.conflict'); this.element.append(label);
        const preview = document.createElement('span'); preview.textContent = t('chatInput.draft.saved')
            + (conflict.saved?.inputText ?? '').slice(0, 160) + (conflict.saved?.inputFiles?.length ? ` (${conflict.saved.inputFiles.length})` : '');
        this.element.append(preview);
        for (const action of ['load', 'replace'] as const) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'llm-btn';
            button.dataset.draftResolve = action; button.disabled = this.busy;
            button.textContent = t(this.busy ? 'chatInput.draft.working' : action === 'load' ? 'chatInput.draft.load' : 'chatInput.draft.replace');
            button.onclick = () => {void this.resolve(action);}; this.element.append(button);
        }
    }
    dispose(): void {this.closed = true; this.release(); this.element.remove();}
    private async resolve(action: 'load' | 'replace'): Promise<void> {
        if (this.closed || this.busy) return;
        this.busy = true; this.error = undefined; this.refresh();
        try {await this.port.resolve(action);}
        catch (error) {this.error = error instanceof Error ? error.message : t('chatInput.draft.saveFailed');}
        finally {this.busy = false; this.refresh();}
    }
}
