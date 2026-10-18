import {isCommandInput} from './commands';
import {CommandPicker} from './command-picker';
import {ComposerSelectors} from './selectors';
import { randomUUID } from './random';
import type { ChatOptions, ComposerDraft, ConversationSnapshot, DraftAttachment } from './contracts';
import { button, element, errorText } from './dom';
import type { Translate } from './i18n';

interface Upload { readonly file: File; readonly abort: AbortController; error?: string }
export class Composer {
    readonly element = element('form', 'llm-chat__composer');
    readonly textarea = element('textarea', 'llm-chat__input');
    readonly feedback = element('p', 'llm-chat__error');
    readonly send: HTMLButtonElement;
    private readonly attachments = element('div', 'llm-chat__attachments');
    private readonly selectors = element('div', 'llm-chat__selectors');
    private readonly candidates = element('div', 'llm-chat__candidates');
    private readonly uploads = new Map<string, Upload>();
    private readonly selection = new ComposerSelectors();
    private readonly commands: CommandPicker;
    private snapshot?: ConversationSnapshot;
    private selectorSignature?: string;
    private draft: ComposerDraft;
    private search?: AbortController;
    private closed = false;
    constructor(private readonly options: ChatOptions, private readonly t: Translate,
        private readonly changed: (draft: ComposerDraft) => void, private readonly submit: () => void) {
        this.draft = options.initialDraft ?? { revision: 0, textRevision: 0, text: '', attachments: [] };
        this.textarea.value = this.draft.text; this.textarea.setAttribute('aria-label', t('input'));
        this.commands = new CommandPicker(this.textarea, text => this.setText(text), t);
        this.send = element('button', undefined, t('send')); this.send.type = 'submit';
        this.element.append(this.attachments, this.selectors, this.textarea, this.commands.element, this.candidates, this.send, this.feedback);
        this.bind(); this.renderAttachments();
    }
    private bind(): void {
        this.element.addEventListener('submit', event => { event.preventDefault(); this.submit(); });
        this.textarea.addEventListener('input', () => { this.setText(this.textarea.value); this.commands.refresh(); void this.findResources(); });
        this.textarea.addEventListener('keydown', event => {
            if (this.commands.key(event)) return;
            if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.shiftKey) return;
            if (!event.ctrlKey && !event.metaKey && globalThis.matchMedia?.('(pointer: coarse)').matches) return;
            event.preventDefault(); this.submit();
        });
        if (!this.options.upload) return;
        const picker = element('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
        picker.addEventListener('change', () => { void this.addFiles(Array.from(picker.files ?? [])); picker.value = ''; });
        this.element.append(button(this.t('attach'), () => picker.click()), picker);
        this.textarea.addEventListener('paste', event => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length) { event.preventDefault(); void this.addFiles(files); }
        });
        this.element.addEventListener('dragover', event => event.preventDefault());
        this.element.addEventListener('drop', event => { event.preventDefault(); void this.addFiles(Array.from(event.dataTransfer?.files ?? [])); });
    }
    getDraft(): ComposerDraft { return this.draft; }
    getSelection(): Readonly<Record<string, string>> { return this.selection.snapshot(); }
    getCommand() {return this.commands.resolve(this.draft.text);}
    get commandDraft(): boolean {return this.snapshot?.commands !== undefined && isCommandInput(this.draft.text);}
    setActive(active: boolean): void {this.commands.setActive(active); if (!active) {this.search?.abort(); this.candidates.replaceChildren();}}
    get uploading(): boolean { return [...this.uploads.values()].some(upload => !upload.error); }
    setText(text: string): void {
        if (this.closed || text === this.draft.text) return;
        this.textarea.value = text; this.commands.refresh();
        this.publish({ ...this.draft, text, textRevision: this.draft.textRevision + 1 });
    }
    accept(submitted: ComposerDraft): void {
        const clear = this.draft.textRevision === submitted.textRevision && this.draft.text === submitted.text;
        const ids = new Set(submitted.attachments.map(item => item.id));
        const attachments = this.draft.attachments.filter(item => !ids.has(item.id));
        if (!clear && attachments.length === this.draft.attachments.length) return;
        const text = clear ? '' : this.draft.text;
        this.textarea.value = text; this.commands.refresh();
        this.publish({ ...this.draft, text, attachments, textRevision: this.draft.textRevision + (clear ? 1 : 0) });
        this.renderAttachments();
    }
    private publish(draft: ComposerDraft): void {
        this.draft = { ...draft, revision: this.draft.revision + 1 };
        this.changed(this.draft);
    }
    async addFiles(files: readonly File[]): Promise<void> {
        if (this.closed || !this.options.upload) return;
        await Promise.all(files.map(file => this.upload(randomUUID(), file)));
    }
    private async upload(id: string, file: File): Promise<void> {
        const entry: Upload = { file, abort: new AbortController() };
        this.uploads.set(id, entry); this.renderAttachments(); this.changed(this.draft);
        try {
            const ref = await this.options.upload!(file, { signal: entry.abort.signal });
            if (this.closed || this.uploads.get(id) !== entry) return;
            this.uploads.delete(id);
            this.publish({ ...this.draft, attachments: [...this.draft.attachments, { id, file: ref }] });
        } catch (error) {
            if (!this.closed && this.uploads.get(id) === entry) entry.error = errorText(error);
        } finally { if (!this.closed) { this.renderAttachments(); this.changed(this.draft); } }
    }
    private renderAttachments(): void {
        this.attachments.replaceChildren();
        for (const item of this.draft.attachments) this.attachment(item);
        for (const [id, upload] of this.uploads) {
            const row = element('div', undefined, `${upload.file.name}: ${upload.error ?? this.t('upload')}`);
            row.dataset.uploadId = id;
            row.append(button(this.t('remove'), () => { upload.abort.abort(); this.uploads.delete(id); this.renderAttachments(); this.changed(this.draft); }));
            if (upload.error) row.append(button(this.t('retry'), () => { void this.upload(id, upload.file); }));
            this.attachments.append(row);
        }
    }
    private attachment(item: DraftAttachment): void {
        const row = element('div', undefined, item.file.name); row.dataset.attachmentId = item.id;
        row.append(button(this.t('remove'), () => {
            this.publish({ ...this.draft, attachments: this.draft.attachments.filter(value => value.id !== item.id) });
            this.renderAttachments();
        }));
        this.attachments.append(row);
    }
    update(snapshot: ConversationSnapshot, canSend: boolean): void {
        this.send.disabled = !canSend || this.uploading || !this.draft.text.trim() && !this.draft.attachments.length;
        this.snapshot = snapshot; this.commands.update(snapshot.commands ?? []);
        this.renderSelectors();
    }
    private renderSelectors(): void {
        const selectors = this.snapshot?.selectors ?? [];
        this.selection.update(selectors);
        const signature = JSON.stringify([selectors, this.selection.snapshot()]);
        if (signature === this.selectorSignature) return;
        this.selectorSignature = signature; this.selectors.replaceChildren();
        for (const selector of selectors) {
            const label = element('label', undefined, selector.label), select = element('select');
            select.dataset.selectorId = selector.id; select.disabled = selector.disabled ?? false;
            for (const choice of this.selection.choices(selector)) {const option = element('option', undefined, choice.label); option.value = choice.id; select.append(option);}
            select.value = this.selection.get(selector.id);
            select.addEventListener('change', () => {this.selection.set(selector.id, select.value); this.renderSelectors();});
            label.append(select); this.selectors.append(label);
        }
    }
    private async findResources(): Promise<void> {
        this.search?.abort(); this.candidates.replaceChildren();
        const match = this.textarea.value.slice(0, this.textarea.selectionStart).match(/@([^\s@]*)$/);
        if (!match || !this.options.searchResources) return;
        const search = this.search = new AbortController(), text = this.draft.text, cursor = this.textarea.selectionStart;
        try {
            const candidates = await this.options.searchResources(match[1], { signal: search.signal });
            if (search.signal.aborted || this.closed || this.draft.text !== text) return;
            for (const item of candidates) this.candidates.append(button(item.label, () => {
                this.setText(text.slice(0, cursor - match[0].length) + item.insertText + text.slice(cursor));
                this.candidates.replaceChildren(); this.textarea.focus();
            }));
        } catch (error) { if (!search.signal.aborted) this.options.onError?.(error); }
    }
    destroy(): void {
        this.closed = true; this.commands.setActive(false); this.search?.abort();
        for (const upload of this.uploads.values()) upload.abort.abort();
        this.uploads.clear();
    }
}
