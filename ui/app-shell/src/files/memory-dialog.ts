import { t } from '@itookit/common';
import type { MemoryEntry, SessionMemoryControls } from '@itookit/llm-session/contracts';
import { showMemorySharingDialog } from './memory-sharing-dialog';

/** The caller supplies controls pinned to the Session being displayed. */
export function showMemoryDialog(memory: SessionMemoryControls, agents: Array<{ id: string; name: string }>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => new MemoryDialog(memory, agents, signal, resolve).open());
}

class MemoryDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly agent = document.createElement('select');
    private readonly entries = document.createElement('div');
    private readonly scope = document.createElement('input');
    private readonly identity = document.createElement('input');
    private readonly content = document.createElement('textarea');
    private readonly status = document.createElement('p');
    private readonly comparison = document.createElement('pre');
    private selected?: MemoryEntry;
    private compared?: MemoryEntry;
    private comparisonReady = false;
    private busy = false;

    constructor(private readonly memory: SessionMemoryControls, private readonly agents: Array<{ id: string; name: string }>,
        private readonly signal: AbortSignal | undefined, private readonly done: () => void) {}

    open(): void {
        this.dialog.className = 'session-memory-dialog';
        const title = document.createElement('h2'); title.textContent = t('memory.manage.title');
        this.dialog.append(title);
        for (const agent of this.agents) {
            const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name; this.agent.append(option);
        }
        this.field('memory.manage.agent', this.agent);
        this.dialog.append(this.entries);
        this.field('memory.manage.scope', this.scope); this.field('memory.manage.id', this.identity);
        this.field('memory.manage.content', this.content);
        this.button(t('memory.manage.new'), () => this.edit());
        this.button(t('memory.manage.save'), () => this.run(() => this.save()));
        this.button(t('memory.manage.delete'), () => this.run(() => this.remove()));
        this.button(t('memory.manage.refresh'), () => this.run(() => this.refresh()));
        this.button(t('memory.manage.compare'), () => this.run(() => this.compare()));
        this.button(t('memory.manage.useCompared'), () => this.useCompared());
        if (this.memory.sharing) this.button(t('memory.sharing.title'), () => this.run(async () => {
            await showMemorySharingDialog(this.memory.sharing, this.agent.value, this.signal); await this.refresh();
        }));
        this.button(t('memory.manage.close'), this.close);
        this.comparison.hidden = true; this.comparison.setAttribute('aria-label', t('memory.manage.latest'));
        this.dialog.append(this.comparison);
        this.status.setAttribute('role', 'status'); this.dialog.append(this.status);
        this.agent.onchange = () => { this.edit(); this.run(() => this.refresh()); };
        this.dialog.oncancel = event => { event.preventDefault(); if (!this.busy) this.close(); };
        this.signal?.addEventListener('abort', this.close, { once: true });
        document.body.append(this.dialog); this.dialog.showModal(); this.run(() => this.refresh());
    }

    private field(key: Parameters<typeof t>[0], control: HTMLElement): void {
        const label = document.createElement('label'); label.textContent = t(key);
        control.setAttribute('aria-label', t(key)); label.append(control); this.dialog.append(label);
    }

    private button(text: string, action: () => void): void {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.onclick = action; this.dialog.append(button);
    }

    private edit(entry?: MemoryEntry): void {
        this.comparisonReady = false; this.compared = undefined; this.comparison.hidden = true;
        this.selected = entry;
        this.scope.value = entry?.scope ?? ''; this.identity.value = entry?.entryId ?? '';
        this.scope.readOnly = this.identity.readOnly = Boolean(entry);
        this.content.value = entry?.content ?? '';
    }

    private async refresh(): Promise<void> {
        const entries = await this.memory.list(this.agent.value);
        this.entries.replaceChildren(); this.edit();
        for (const entry of entries) {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = `${entry.scope} / ${entry.entryId}`; button.onclick = () => this.edit(entry); this.entries.append(button);
        }
        this.status.textContent = entries.length ? '' : t('memory.manage.empty');
    }

    private async save(): Promise<void> {
        await this.memory.upsert(this.agent.value, { scope: this.scope.value, entryId: this.identity.value, content: this.content.value },
            { expectedContentHash: this.selected?.contentHash ?? null, expectedRevision: this.selected?.revision ?? null });
        await this.refresh();
    }

    private async remove(): Promise<void> {
        if (!this.selected) return;
        await this.memory.remove(this.agent.value, this.selected.scope, this.selected.entryId,
            { expectedContentHash: this.selected.contentHash, expectedRevision: this.selected.revision });
        await this.refresh();
    }

    private async compare(): Promise<void> {
        const entries = await this.memory.list(this.agent.value);
        this.compared = entries.find(entry => entry.scope === this.scope.value && entry.entryId === this.identity.value);
        this.comparison.textContent = this.compared?.content ?? t('memory.manage.deleted');
        this.comparison.hidden = false; this.comparisonReady = true;
        this.status.textContent = t('memory.manage.compareHint');
    }

    private useCompared(): void {
        if (!this.comparisonReady) return;
        this.selected = this.compared;
        this.scope.readOnly = this.identity.readOnly = Boolean(this.selected);
        this.comparisonReady = false;
        this.status.textContent = t('memory.manage.retryHint');
    }

    private run(action: () => Promise<void>): void {
        if (this.busy) return;
        this.busy = true; this.disable(true); this.status.textContent = '';
        void action().catch(error => { this.status.textContent = error instanceof Error ? error.message : String(error); })
            .finally(() => { this.busy = false; this.disable(false); });
    }

    private disable(disabled: boolean): void {
        this.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')
            .forEach(control => { control.disabled = disabled; });
    }

    private readonly close = (): void => {
        this.signal?.removeEventListener('abort', this.close); this.dialog.remove(); this.done();
    };
}
