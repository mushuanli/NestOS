import { CHAT_ICONS, escapeHTML, t } from '@itookit/common';
import { SessionCommand, type ICommandBus, type InstructionQueueEdit, type SessionInstructionQueue } from '@itookit/llm-session/contracts';

/** A projection and command editor; dispatch belongs exclusively to the Session backend. */
export class InstructionQueuePanel {
    private queue?: SessionInstructionQueue;
    private readonly selected = new Set<string>();
    private busy = false;
    private closed = false;
    private error = '';
    private readonly events = new AbortController();
    constructor(private readonly element: HTMLElement, private readonly commands: ICommandBus, private readonly sessionId: string) {
        element.className = 'llm-instruction-queue'; element.hidden = true;
        element.addEventListener('click', event => this.click(event), { signal: this.events.signal });
        element.addEventListener('change', event => {
            const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-select]');
            if (!input) return;
            if (input.checked) this.selected.add(input.dataset.select!); else this.selected.delete(input.dataset.select!);
            this.render();
        }, { signal: this.events.signal });
    }

    update(queue?: SessionInstructionQueue): void {
        if (this.closed || !queue || queue.sessionId !== this.sessionId || (this.queue && queue.revision < this.queue.revision)) return;
        this.queue = queue;
        for (const id of this.selected) if (!queue.items.some(item => item.id === id && item.state === 'pending')) this.selected.delete(id);
        this.render();
    }

    private render(): void {
        const queue = this.queue;
        if (!queue) return;
        this.element.hidden = !this.error && (!queue.items.length || queue.items.length === 1 && queue.items[0].state === 'dispatching' && !queue.paused);
        this.element.setAttribute('aria-label', t('session.instructions.title'));
        this.element.innerHTML = `<header><strong>${escapeHTML(t('session.instructions.title'))} · ${queue.items.length}</strong>
            ${this.button(queue.paused ? 'resume' : 'pause', queue.paused ? t('session.instructions.resume') : t('session.instructions.pause'))}
            ${this.button('merge', t('session.instructions.merge'), this.selected.size < 2)}</header>
            <p class="llm-instruction-queue__hint">${escapeHTML(queue.paused ? t('session.instructions.paused') : t('session.instructions.hint'))}</p>
            ${queue.reason ? `<p class="llm-instruction-queue__reason">${escapeHTML(t(`session.instructions.reason.${queue.reason}`))}</p>` : ''}
            <ol>${queue.items.map((item, index) => this.row(item, index)).join('')}</ol>
            <p class="llm-instruction-queue__error" role="alert">${escapeHTML(this.error)}</p>`;
    }

    private row(item: SessionInstructionQueue['items'][number], index: number): string {
        const pending = item.state === 'pending', waiting = this.queue!.items.filter(entry => entry.state === 'pending');
        const position = waiting.findIndex(entry => entry.id === item.id);
        return `<li data-instruction="${escapeHTML(item.id)}"><label><input type="checkbox" data-select="${escapeHTML(item.id)}"
            ${this.selected.has(item.id) ? 'checked' : ''} ${!pending || this.busy ? 'disabled' : ''}>
            <span class="llm-instruction-queue__text">${escapeHTML(item.text)}</span></label>
            <span class="llm-instruction-queue__meta">${index + 1} · ${escapeHTML(t(`session.instructions.${item.state}`))} · ${escapeHTML(item.agentId)}${item.files.length ? ` · ${item.files.length} ${escapeHTML(t('session.instructions.attachments'))}` : ''}</span>
            <div class="llm-instruction-queue__actions">${this.button('up', t('session.instructions.up'), !pending || position === 0)}
            ${this.button('down', t('session.instructions.down'), !pending || position === waiting.length - 1)}
            ${item.state === 'failed' ? this.button('retry', t('session.instructions.retry')) : ''}
            ${this.button('remove', t('action.delete'), item.state === 'dispatching', CHAT_ICONS.delete)}</div>
            ${item.error ? `<p class="llm-instruction-queue__error">${escapeHTML(item.error)}</p>` : ''}</li>`;
    }

    private button(action: string, label: string, disabled = false, icon?: string): string {
        return `<button type="button" data-action="${action}" title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}" ${disabled || this.busy ? 'disabled' : ''}>${icon ?? escapeHTML(label)}</button>`;
    }

    private click(event: Event): void {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
        if (!button || button.disabled || !this.queue) return;
        const action = button.dataset.action!, id = button.closest<HTMLElement>('[data-instruction]')?.dataset.instruction;
        if (action === 'up' || action === 'down') {
            const ids = this.queue.items.filter(item => item.state === 'pending').map(item => item.id);
            const from = ids.indexOf(id!), to = from + (action === 'up' ? -1 : 1);
            [ids[from], ids[to]] = [ids[to], ids[from]];
            void this.edit({ action: 'reorder', ids });
        } else if (action === 'merge') void this.edit({ action, ids: [...this.selected] });
        else if (action === 'pause' || action === 'resume') void this.edit({ action });
        else if (action === 'remove' || action === 'retry') void this.edit({ action, id: id! });
    }

    private async edit(edit: Omit<Extract<InstructionQueueEdit, {action: 'remove' | 'retry'}>, 'expectedRevision'>
        | Omit<Extract<InstructionQueueEdit, {action: 'merge' | 'reorder'}>, 'expectedRevision'>
        | { action: 'pause' | 'resume' }): Promise<void> {
        if (this.busy || !this.queue) return;
        const expectedRevision = this.queue.revision;
        this.busy = true; this.error = ''; this.render();
        try {
            const queue = await this.commands.execute<SessionInstructionQueue>(SessionCommand.EditInstructionQueue, { ...edit, expectedRevision });
            this.update(queue);
        } catch (error) {
            this.error = error instanceof Error ? error.message : t('session.instructions.editFailed');
            try { this.update(await this.commands.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)); }
            catch { /* Preserve the last confirmed projection and the actionable error. */ }
        } finally { this.busy = false; if (!this.closed) this.render(); }
    }

    destroy(): void { this.closed = true; this.events.abort(); this.element.remove(); }
}
