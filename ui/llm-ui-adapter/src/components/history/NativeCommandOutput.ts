import {createModuleLogger, escapeHTML, t} from '@itookit/common';
import type {ConversationCommandOutput} from '@itookit/ui-common';
import {readNativeCommandContent, type CommandOutputReader} from './native-command-content';
export type {CommandOutputReader} from './native-command-content';

const PAGE_CHARS = 64 * 1024;
const log = createModuleLogger('native-command-output');

/** The view owns only bounded result reads, URLs and DOM; execution stays in its host. */
export class NativeCommandOutput {
    readonly element = document.createElement('section');
    private output?: ConversationCommandOutput;
    private fingerprint = '';
    private controller = new AbortController();
    private pending = false;
    private active = true;
    private disposed = false;
    private error?: string;
    private text?: string;
    private page = 0;
    private readonly urls = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly clicked = (event: Event) => this.click(event);
    constructor(private readonly reader: CommandOutputReader) {
        this.element.className = 'native-command-output';
        this.element.addEventListener('click', this.clicked);
    }
    update(output: ConversationCommandOutput): void {
        if (this.disposed) return;
        const fingerprint = JSON.stringify(output);
        if (this.fingerprint === fingerprint) return;
        this.cancel(); this.output = structuredClone(output); this.fingerprint = fingerprint;
        this.error = undefined; this.text = undefined; this.page = 0; this.render();
    }
    setActive(active: boolean): void {this.active = active; if (!active) this.cancel();}
    destroy(): void {
        this.disposed = true; this.cancel(); this.element.removeEventListener('click', this.clicked);
        this.text = undefined; this.element.remove();
    }
    private cancel(): void {
        this.controller.abort(); this.controller = new AbortController(); this.pending = false;
        for (const [url, timer] of this.urls) {clearTimeout(timer); URL.revokeObjectURL(url);} this.urls.clear();
        if (!this.disposed && this.output) this.render();
    }
    private render(): void {
        const output = this.output; if (this.disposed || !output) return;
        this.element.dataset.nativeCommandOutput = output.commandId;
        this.element.innerHTML = `<strong>${escapeHTML(t('harness.commandOutput.title'))}</strong>
            ${this.notices(output)}
            ${output.ref ? this.actions() : ''}
            ${this.pending ? `<p role="status">${escapeHTML(t('harness.commandOutput.loading'))}</p>` : ''}
            ${this.error ? `<p role="alert">${escapeHTML(this.error)}</p>` : ''}
            ${this.text === undefined ? '' : this.preview()}`;
    }
    private notices(output: ConversationCommandOutput): string {
        const notice = output.truncated && output.ref ? `<p>${escapeHTML(t('harness.commandOutput.preview', {bytes: output.ref.bytes}))}</p>` : '';
        const unavailable = output.unavailable?.code ?? (output.ref && !this.hasReader() ? 'ECAPABILITY' : undefined);
        return notice + (unavailable ? `<p role="alert">${escapeHTML(t('harness.commandOutput.unavailable', {code: safeCode(unavailable)}))}</p>` : '');
    }
    private actions(): string {
        const disabled = this.pending || !this.hasReader();
        return `<div class="native-command-output__actions">
            ${this.button('view', 'harness.commandOutput.view', disabled)}${this.button('download', 'harness.commandOutput.download', disabled)}
            ${this.pending ? this.button('cancel', 'action.cancel') : ''}</div>`;
    }
    private button(action: string, label: Parameters<typeof t>[0], disabled = false): string {
        return `<button type="button" data-command-output-action="${action}" ${disabled ? 'disabled' : ''}>${escapeHTML(t(label))}</button>`;
    }
    private preview(): string {
        const text = this.text!, pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
        return `<div class="native-command-output__body"><pre>${escapeHTML(textPage(text, this.page))}</pre>
            <div class="native-command-output__actions">${this.button('previous', 'harness.commandOutput.previous', !this.page)}
            <span>${escapeHTML(t('harness.commandOutput.page', {page: this.page + 1, pages}))}</span>
            ${this.button('next', 'harness.commandOutput.next', this.page + 1 >= pages)}</div></div>`;
    }
    private click(event: Event): void {
        const action = this.action(event); if (!action) return;
        if (action === 'cancel') {this.cancel(); return;}
        if (action === 'view' || action === 'download') {void this.read(action === 'download'); return;}
        this.paginate(action);
    }
    private action(event: Event): string | undefined {
        if (this.disposed || !this.active || !(event.target instanceof Element)) return;
        return event.target.closest<HTMLButtonElement>('[data-command-output-action]')?.dataset.commandOutputAction;
    }
    private paginate(action: string): void {
        if (action === 'previous' && this.page) {--this.page; this.render();}
        if (action === 'next' && this.text && (this.page + 1) * PAGE_CHARS < this.text.length) {++this.page; this.render();}
    }
    private async read(download: boolean): Promise<void> {
        const output = this.output;
        if (!this.canRead(output)) return;
        const signal = this.controller.signal, started = Date.now(); this.pending = true; this.error = undefined; this.render();
        try {
            const content = await readNativeCommandContent(this.reader, output!.commandId, output!.ref!, signal); signal.throwIfAborted();
            if (download) this.download(content); else {this.text = new TextDecoder('utf-8', {fatal: true}).decode(content); this.page = 0;}
            report(output!, 'verified', started);
        } catch (error) {
            if (!signal.aborted) {this.error = t('harness.commandOutput.failed', {code: safeCode((error as {code?: unknown})?.code)}); report(output!, 'failed', started, error);}
        } finally {if (!signal.aborted) {this.pending = false; this.render();}}
    }
    private canRead(output?: ConversationCommandOutput): boolean {return !this.pending && !!output?.ref && this.hasReader();}
    private hasReader(): boolean {return !!this.reader.readCommandOutput || !!this.reader.loadCommandOutput;}
    private download(content: ArrayBuffer): void {
        const url = URL.createObjectURL(new Blob([content], {type: 'text/plain;charset=utf-8'}));
        const timer = setTimeout(() => {URL.revokeObjectURL(url); this.urls.delete(url);}, 1000); this.urls.set(url, timer);
        const link = document.createElement('a'); link.href = url; link.download = t('harness.commandOutput.filename');
        this.element.append(link); try {link.click();} finally {link.remove();}
    }
}

function textPage(text: string, page: number): string {
    const boundary = (offset: number) => offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] ?? '') ? offset - 1 : offset;
    return text.slice(boundary(page * PAGE_CHARS), boundary(Math.min(text.length, (page + 1) * PAGE_CHARS)));
}
function safeCode(code: unknown): string {return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'COMMAND_OUTPUT_READ_FAILED';}
function report(output: ConversationCommandOutput, result: string, started: number, error?: unknown): void {
    const operationId = output.ref?.requestId;
    const data = {operation: 'native.command.output', operationId: operationId && /^[\w-]{1,128}$/.test(operationId) ? operationId : undefined, stage: 'read', result,
        bytes: output.ref?.bytes, durationMs: Date.now() - started, ...(error ? {code: safeCode((error as {code?: unknown})?.code)} : {})};
    if (error) log.warn('Native command output read', data); else log.info('Native command output read', data);
}
