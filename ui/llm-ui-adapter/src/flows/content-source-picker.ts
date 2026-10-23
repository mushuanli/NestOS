import { escapeHTML, t } from '@itookit/common';
import { ContentTransferCommand, type ContentCapture, type ContentTransfer, type ICommandBus, type TransferSelection } from '@itookit/llm-session/contracts';

type SourceKind = 'custom' | 'latest' | 'conversation' | 'replies' | 'summary' | 'selected' | 'output';
interface PickerOptions {
    commands: ICommandBus; sessionId: string; capture(): Promise<ContentCapture>;
    apply(transfer: ContentTransfer): void; clear(): void;
}
const sourceKinds: SourceKind[] = ['custom', 'latest', 'conversation', 'replies', 'summary', 'selected', 'output'];

/** Sources are prepared explicitly, then previewed before the enclosing form is submitted. */
export class ContentSourcePicker {
    private element = document.createElement('section');
    private abort = new AbortController();
    private revision = 0;
    private busy = false;
    private applied = false;
    private capture?: ContentCapture;
    private kind: SourceKind = 'custom';
    constructor(parent: HTMLElement, private readonly options: PickerOptions) {
        this.element.className = 'flow-content-source';
        this.element.innerHTML = `<label>${escapeHTML(t('flow.source.label'))}<select data-content-source>${sourceKinds.map(kind =>
            `<option value="${kind}">${escapeHTML(t(`flow.source.${kind}`))}</option>`).join('')}</select></label>
            <div data-source-choices hidden></div><button type="button" data-source-apply hidden>${escapeHTML(t('flow.source.prepare'))}</button>
            <p data-source-error role="alert"></p><details data-source-preview hidden><summary>${escapeHTML(t('flow.source.preview'))}</summary><pre></pre><small></small></details>`;
        parent.append(this.element);
        this.element.querySelector('select')!.addEventListener('change', () => { void this.change(); }, { signal: this.abort.signal });
        this.element.querySelector('[data-source-apply]')!.addEventListener('click', () => { void this.prepare(); }, { signal: this.abort.signal });
        this.element.querySelector('[data-source-choices]')!.addEventListener('change', () => this.invalidate(), { signal: this.abort.signal });
    }
    validate(): void {
        if (this.busy || this.kind !== 'custom' && !this.applied) throw new Error(t('flow.source.notPrepared'));
    }
    clear(): void { this.revision++; this.setBusy(false); this.applied = false; this.options.clear(); }
    edited(): void {
        this.clear(); this.kind = 'custom';
        this.element.querySelector<HTMLSelectElement>('[data-content-source]')!.value = 'custom';
        this.element.querySelector<HTMLElement>('[data-source-apply]')!.hidden = true;
        this.element.querySelector<HTMLElement>('[data-source-choices]')!.hidden = true;
        this.element.querySelector<HTMLElement>('[data-source-preview]')!.hidden = true;
    }
    destroy(): void { this.abort.abort(); this.revision++; this.element.remove(); }
    private invalidate(): void { this.applied = false; this.options.clear(); }
    private async change(): Promise<void> {
        this.kind = this.element.querySelector<HTMLSelectElement>('[data-content-source]')!.value as SourceKind;
        this.clear(); this.error('');
        this.element.querySelector<HTMLElement>('[data-source-preview]')!.hidden = true;
        this.element.querySelector<HTMLElement>('[data-source-apply]')!.hidden = this.kind === 'custom';
        const choices = this.element.querySelector<HTMLElement>('[data-source-choices]')!;
        choices.hidden = !['selected', 'output'].includes(this.kind);
        if (this.kind === 'custom') return;
        const revision = ++this.revision; this.setBusy(true);
        try {
            const capture = await this.options.capture();
            if (this.abort.signal.aborted || revision !== this.revision) return;
            this.capture = capture; this.renderChoices(choices, capture);
        } catch (error) { if (revision === this.revision && !this.abort.signal.aborted) this.error(contentSourceError(error)); }
        finally { if (revision === this.revision) this.setBusy(false); }
    }
    private renderChoices(root: HTMLElement, capture: ContentCapture): void {
        if (this.kind === 'selected') root.innerHTML = capture.messages.map(message => `<label class="flow-content-source__message"><input type="checkbox" value="${escapeHTML(message.id)}">
            <span>${escapeHTML(t(message.role === 'user' ? 'flow.source.user' : 'flow.source.assistant'))} · ${escapeHTML(message.text.slice(0, 160))}</span></label>`).join('');
        if (this.kind === 'output') root.innerHTML = `<select aria-label="${escapeHTML(t('flow.source.output'))}">${capture.outputs.map(output =>
            `<option value="${escapeHTML(output.id)}">${escapeHTML(output.label)}</option>`).join('')}</select>`;
    }
    private selection(): TransferSelection {
        if (this.kind === 'selected') return { kind: 'selected', messageIds: [...this.element.querySelectorAll<HTMLInputElement>('input:checked')].map(item => item.value) };
        if (this.kind === 'output') return { kind: 'output', outputId: this.element.querySelector<HTMLSelectElement>('[data-source-choices] select')?.value ?? '' };
        if (this.kind === 'custom') throw new Error(t('flow.source.notPrepared'));
        return { kind: this.kind };
    }
    private async prepare(): Promise<void> {
        if (this.busy || this.kind === 'custom') return;
        const revision = ++this.revision; this.setBusy(true); this.error(''); this.invalidate();
        this.element.querySelector<HTMLElement>('[data-source-preview]')!.hidden = true;
        try {
            const capture = this.capture ?? await this.options.capture();
            const transfer = await this.options.commands.execute<ContentTransfer>(ContentTransferCommand.Resolve,
                { sessionId: this.options.sessionId, captureId: capture.id, selection: this.selection() });
            if (this.abort.signal.aborted || revision !== this.revision) return;
            this.options.apply(transfer); this.applied = true;
            const preview = this.element.querySelector<HTMLDetailsElement>('[data-source-preview]')!;
            preview.hidden = false; preview.open = true;
            preview.querySelector('pre')!.textContent = typeof transfer.value === 'string' ? transfer.value : JSON.stringify(transfer.value, null, 2);
            preview.querySelector('small')!.textContent = [transfer.output?.label,
                t('flow.source.frozen', { branch: transfer.branch, count: transfer.messageIds.length })].filter(Boolean).join(' · ');
        } catch (error) { if (revision === this.revision && !this.abort.signal.aborted) this.error(contentSourceError(error)); }
        finally { if (revision === this.revision) this.setBusy(false); }
    }
    private setBusy(value: boolean): void {
        this.busy = value;
        const button = this.element.querySelector<HTMLButtonElement>('[data-source-apply]')!;
        button.disabled = value; button.textContent = t(value ? 'flow.source.preparing' : 'flow.source.prepare');
        this.element.setAttribute('aria-busy', String(value));
    }
    private error(message: string): void { this.element.querySelector('[data-source-error]')!.textContent = message; }
}

export function contentSourceError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const key = `flow.source.error.${message}`;
    const translated = t(key as Parameters<typeof t>[0]);
    return translated === key ? message : translated;
}
