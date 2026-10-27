import {sha256HexSync, t} from '@itookit/common';
import type {EditorFactory, EditorOptions, IEditor} from '@itookit/ui-common';
import {FileRecoveryStore, type FileRecovery} from '../persistence/file-recovery-store';

/** Read only this file's recovery record before making its editor interactive. */
export async function createRecoverableFileEditor(factory: EditorFactory, panel: HTMLElement, options: EditorOptions, scope: string): Promise<IEditor> {
    if (options.target?.kind !== 'file') return factory(panel, options);
    const store = new FileRecoveryStore(scope, options.target.path), original = options.initialContent ?? '';
    let draft: FileRecovery | undefined, unavailable = false;
    try { draft = await store.read(); } catch { unavailable = true; }
    let path = options.target.path;
    const editor = await factory(panel, {...options, hostContext: options.hostContext ? {...options.hostContext,
        reloadRecovery: options.hostContext.reloadRecovery ?? {
            preserve: text => new FileRecoveryStore(scope, path, 'reload-backup').write({base: sha256HexSync(original), text, savedAt: Date.now()}),
            read: async () => {
                const backup = await new FileRecoveryStore(scope, path, 'reload-backup').read();
                return backup ? {content: backup.text, savedAt: backup.savedAt} : undefined;
            },
        },
    } : undefined});
    if (typeof editor.on !== 'function' || typeof editor.getText !== 'function') return editor;
    const recovery = new FileRecoveryBinding(editor, panel, store, scope, original, !!options.readOnly, draft, unavailable);
    if (!editor.captureRecovery) {
        editor.captureRecovery = () => recovery.snapshot();
        editor.restoreRecovery = state => recovery.restore(state);
        editor.suspendForRecovery = () => {editor.flushPendingSave = async () => {}; recovery.release();};
    }
    const rename = editor.updateNodeId?.bind(editor);
    if (rename) editor.updateNodeId = next => {rename(next); path = next; recovery.move(next);};
    const destroy = editor.destroy.bind(editor);
    editor.destroy = async () => { await destroy(); recovery.release(); };
    return editor;
}

class FileRecoveryBinding {
    private base: string;
    private tail = Promise.resolve();
    private pending = 0;
    private failed: boolean;
    private closed = false;
    private conflict = false;
    private readonly stops: Array<() => void>;
    private readonly guard = (event: BeforeUnloadEvent) => {
        if (this.pending || this.failed) {event.preventDefault(); event.returnValue = '';}
    };
    constructor(private readonly editor: IEditor, private readonly panel: HTMLElement, private store: FileRecoveryStore,
        private readonly scope: string, original: string, private readonly readOnly: boolean, private draft?: FileRecovery, unavailable = false) {
        this.base = sha256HexSync(original); this.failed = unavailable;
        this.stops = [editor.on('change', () => this.capture()), editor.on('saveError', () => this.capture()), editor.on('saved', () => this.saved()), editor.on('contentLoaded', () => this.saved())];
        window.addEventListener('beforeunload', this.guard);
        if (unavailable) this.failure();
        if (draft && draft.text !== original) {
            if (draft.base === this.base && !readOnly) {editor.setText(draft.text); editor.setDirty?.(true);}
            else {
                this.conflict = true; editor.setReadOnly(true);
                showConflict(panel, draft.text, async () => {await this.store.clear(); this.conflict = false; editor.setReadOnly(readOnly);});
            }
        } else if (draft) this.enqueue(() => this.store.clear());
    }
    private enqueue(write: () => Promise<void>): void {
        ++this.pending;
        this.tail = this.tail.then(write).then(() => {
            this.failed = false; this.panel.querySelector('[data-file-recovery-error]')?.remove();
        }).catch(() => this.failure()).finally(() => {--this.pending;});
    }
    private capture(): void {
        if (this.conflict) return;
        const record = {base: this.base, text: this.editor.getText()}, store = this.store;
        this.enqueue(() => store.write(record));
    }
    private saved(): void {
        if (this.conflict) return;
        if (this.editor.isDirty?.()) {this.capture(); return;}
        this.base = sha256HexSync(this.editor.getText());
        const store = this.store; this.enqueue(() => store.clear());
    }
    private failure(): void {
        this.failed = true;
        if (this.closed || this.panel.querySelector('[data-file-recovery-error]')) return;
        const notice = document.createElement('p'); notice.dataset.fileRecoveryError = ''; notice.setAttribute('role', 'alert');
        notice.textContent = t('fileRecovery.unavailable'); this.panel.append(notice);
    }
    move(path: string): void {
        const previous = this.store, next = new FileRecoveryStore(this.scope, path); this.store = next;
        const record = this.conflict && this.draft ? this.draft : {base: this.base, text: this.editor.getText()};
        this.enqueue(async () => {await next.write(record); await previous.clear();});
    }
    snapshot(): unknown {
        return {...(this.conflict && this.draft ? this.draft : {base: this.base, text: this.editor.getText()}), mode: this.editor.getMode()};
    }
    restore(snapshot: unknown): void {
        const state = snapshot as {base: string; text: string; mode: 'edit' | 'render'};
        if (this.editor.getText() === state.text) {
            void this.editor.switchToMode(state.mode).catch(() => this.failure()); return;
        }
        if (state.base !== this.base || this.readOnly) {
            this.draft = state; this.conflict = true; this.editor.setReadOnly(true);
            showConflict(this.panel, state.text, async () => {await this.store.clear(); this.conflict = false; this.editor.setReadOnly(this.readOnly);});
            return;
        }
        this.editor.setText(state.text); this.editor.setDirty(true); this.capture();
        void this.editor.switchToMode(state.mode).catch(() => this.failure());
    }
    release(): void {this.closed = true; this.stops.forEach(stop => stop()); window.removeEventListener('beforeunload', this.guard);}
}

function showConflict(panel: HTMLElement, text: string, discard: () => Promise<void>): void {
    panel.querySelector('.file-recovery')?.remove();
    const details = document.createElement('details'); details.className = 'file-recovery'; details.open = true;
    const summary = document.createElement('summary'); summary.textContent = t('fileRecovery.conflict');
    const draft = document.createElement('textarea'); draft.value = text; draft.readOnly = true; draft.setAttribute('aria-label', t('fileRecovery.draft'));
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = t('fileRecovery.copy');
    copy.onclick = () => { draft.focus(); draft.select(); void navigator.clipboard?.writeText(text).catch(() => {}); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = t('fileRecovery.discard');
    remove.onclick = () => { void discard().then(() => details.remove()).catch(() => {remove.title = t('fileRecovery.unavailable');}); };
    details.append(summary, draft, copy, remove); panel.append(details);
}
