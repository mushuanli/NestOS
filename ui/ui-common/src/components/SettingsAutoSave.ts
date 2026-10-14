import { t } from '@itookit/common';

export class SettingsValidationError extends Error {}

export type SettingsSave = () => Promise<void | false>;
const controllers = new WeakMap<HTMLElement, SettingsAutoSave>();

/** Schedule programmatic changes such as adding a model or removing a prompt row. */
export function requestSettingsSave(root: HTMLElement): void {
    for (let element: HTMLElement | null = root; element; element = element.parentElement) {
        const controller = controllers.get(element);
        if (controller) { controller.request(0); return; }
    }
}

/** Debounce edits, serialize writes, and retain drafts after validation or storage failures. */
export class SettingsAutoSave {
    private revision = 0;
    private savedRevision = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<boolean>;
    private disposed = false;
    private composing = false;
    private readonly status = document.createElement('span');
    private readonly retry = document.createElement('button');
    private readonly listeners: Array<[string, EventListener]> = [];

    constructor(readonly root: HTMLElement, private readonly save: SettingsSave, statusHost?: HTMLElement) {
        controllers.set(root, this);
        this.status.dataset.autosaveStatus = '';
        this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        this.status.style.cssText = 'font-size:12px;color:var(--st-text-secondary);white-space:pre-wrap';
        this.retry.type = 'button'; this.retry.className = 'settings-btn settings-btn--secondary settings-btn--xs';
        this.retry.textContent = t('settings.autosave.retry'); this.retry.hidden = true;
        this.retry.onclick = () => { void this.flush(); };
        (statusHost ?? root).prepend(this.status, this.retry);
        this.setStatus('idle'); this.bind();
    }

    get isDirty(): boolean { return this.revision !== this.savedRevision; }
    get busy(): boolean { return !!this.running; }
    get protectsInput(): boolean { return this.busy || this.isDirty || this.root.contains(document.activeElement); }

    request(delay = 600): void {
        if (this.disposed) return;
        this.revision++; clearTimeout(this.timer); this.setStatus('pending');
        if (delay >= 0 && !this.composing) this.timer = setTimeout(() => { void this.flush(); }, delay);
    }

    flush(): Promise<boolean> {
        clearTimeout(this.timer);
        if (this.composing) return Promise.resolve(false);
        if (this.running) return this.running;
        if (this.disposed || !this.isDirty) return Promise.resolve(true);
        this.running = this.drain().finally(() => { this.running = undefined; });
        return this.running;
    }

    async dispose(flush = true): Promise<boolean> {
        if (flush && !await this.flush()) return false;
        this.disposed = true; clearTimeout(this.timer);
        if (this.running) await this.running;
        this.listeners.forEach(([type, listener]) => this.root.removeEventListener(type, listener));
        controllers.delete(this.root); this.status.remove(); this.retry.remove();
        return true;
    }

    private async drain(): Promise<boolean> {
        while (!this.disposed && this.isDirty) {
            const revision = this.revision;
            const invalid = this.root.querySelector<HTMLInputElement>('input:invalid, select:invalid, textarea:invalid');
            if (invalid) { this.setStatus('invalid', invalid.validationMessage); return false; }
            this.setStatus('saving');
            try {
                if (await this.save() === false) { this.setStatus('invalid'); return false; }
                this.savedRevision = revision;
            } catch (error) {
                if (revision !== this.revision) continue;
                this.setStatus(error instanceof SettingsValidationError ? 'invalid' : 'failed', error instanceof Error ? error.message : String(error)); return false;
            }
        }
        this.setStatus('saved'); return true;
    }

    private setStatus(state: 'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'failed', message = ''): void {
        this.status.dataset.state = state;
        this.status.textContent = `${t(`settings.autosave.${state}`)}${message ? `：${message}` : ''}`;
        this.status.setAttribute('aria-busy', String(state === 'saving'));
        this.retry.hidden = state !== 'failed';
        this.retry.style.display = state === 'failed' ? '' : 'none';
    }

    private listen(type: string, listener: EventListener): void {
        this.root.addEventListener(type, listener); this.listeners.push([type, listener]);
    }

    private accepts(target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
        return target instanceof HTMLElement && target.matches('input, select, textarea')
            && !target.matches('[type="search"], [data-autosave-ignore], [data-role="icon-picker-input"]');
    }

    private bind(): void {
        this.listen('input', event => {
            if (!this.accepts(event.target)) return;
            const field = event.target;
            this.request(field.matches('[data-autosave-defer], [type="password"]') ? -1 : field instanceof HTMLTextAreaElement ? 1000 : 600);
        });
        this.listen('change', event => {
            if (!this.accepts(event.target) || this.composing) return;
            this.request(0);
        });
        this.listen('focusout', event => {
            if (this.accepts(event.target) && this.isDirty && !this.composing) void this.flush();
        });
        this.listen('compositionstart', () => { this.composing = true; clearTimeout(this.timer); });
        this.listen('compositionend', event => { this.composing = false; if (this.accepts(event.target)) this.request(600); });
        this.listen('submit', event => { event.preventDefault(); void this.flush(); });
    }
}
