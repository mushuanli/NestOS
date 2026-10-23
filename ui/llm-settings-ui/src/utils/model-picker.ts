import {FILE_BROWSER_ICONS, escapeHTML, randomUUID, createModuleLogger, t} from '@itookit/common';
import './model-picker.css';

export interface ModelPickerChoice {value: string; name: string; detail?: string; disabled?: boolean}
const log = createModuleLogger('model-picker');
interface Options {
    label: string;
    choices(): ModelPickerChoice[];
    matches(choice: ModelPickerChoice, query: string): boolean;
}

/** Retain the native value for form recovery; searching never changes configuration. */
export class ModelPicker {
    readonly trigger = document.createElement('button');
    private readonly dialog = document.createElement('dialog');
    private readonly search = document.createElement('input');
    private readonly list = document.createElement('div');
    private readonly status = document.createElement('small');
    private readonly abort = new AbortController();
    private active = 0;
    private readonly operationId = randomUUID();
    constructor(private readonly select: HTMLSelectElement, private readonly options: Options) {
        this.trigger.type = 'button'; this.trigger.className = 'settings-model-picker';
        this.trigger.setAttribute('aria-haspopup', 'dialog'); this.trigger.setAttribute('aria-expanded', 'false');
        this.select.hidden = true; this.select.after(this.trigger); this.buildDialog(); this.sync();
        this.trigger.onclick = () => this.open();
        this.select.addEventListener('change', () => this.sync(), {signal: this.abort.signal});
        this.search.oninput = () => {this.active = 0; this.renderChoices();};
        this.dialog.addEventListener('keydown', event => this.keydown(event));
        this.dialog.addEventListener('click', event => {if (event.target === this.dialog) this.dialog.close();});
        this.dialog.addEventListener('close', () => {this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.focus();});
        window.addEventListener('resize', () => this.position(), {signal: this.abort.signal});
    }
    private buildDialog(): void {
        const title = document.createElement('strong'), close = document.createElement('button'), header = document.createElement('div');
        title.textContent = this.options.label; close.type = 'button'; close.innerHTML = FILE_BROWSER_ICONS.close;
        close.setAttribute('aria-label', t('action.close')); close.onclick = () => this.dialog.close(); header.append(title, close);
        this.dialog.className = 'settings-model-picker__popup'; header.className = 'settings-model-picker__header';
        this.dialog.setAttribute('aria-label', this.options.label); this.dialog.dataset.modelPicker = this.select.id;
        this.search.type = 'search'; this.search.placeholder = t('connection.modelSearchPlaceholder'); this.search.dataset.autosaveIgnore = '';
        this.search.setAttribute('aria-label', t('connection.modelSearch')); this.search.setAttribute('role', 'combobox');
        this.search.setAttribute('aria-autocomplete', 'list'); this.search.setAttribute('aria-expanded', 'true');
        this.list.id = 'model-choices-' + randomUUID(); this.list.className = 'settings-model-picker__choices'; this.list.setAttribute('role', 'listbox');
        this.search.setAttribute('aria-controls', this.list.id); this.status.setAttribute('role', 'status');
        this.dialog.append(header, this.search, this.status, this.list);
    }
    sync(): void {
        const choice = this.options.choices().find(item => item.value === this.select.value);
        const name = choice?.name ?? this.select.selectedOptions[0]?.textContent ?? this.select.value;
        this.trigger.innerHTML = `<span>${escapeHTML(name)}</span>${FILE_BROWSER_ICONS.chevron}`;
        this.trigger.setAttribute('aria-label', `${this.options.label}: ${name}`); this.trigger.disabled = this.select.disabled;
        if (this.dialog.open) this.renderChoices();
    }
    private open(): void {
        if (this.dialog.open) return;
        this.search.value = ''; this.active = Math.max(0, this.options.choices().findIndex(choice => choice.value === this.select.value)); this.renderChoices(); this.position();
        document.body.append(this.dialog); this.dialog.showModal(); this.trigger.setAttribute('aria-expanded', 'true'); this.search.focus();
    }
    private position(): void {
        const rect = this.trigger.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
        this.dialog.style.setProperty('--picker-left', `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`);
        this.dialog.style.setProperty('--picker-top', `${Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 360))}px`);
        this.dialog.style.setProperty('--picker-width', `${width}px`);
    }
    private renderChoices(): void {
        const started = performance.now(), choices = this.options.choices();
        const visible = choices.filter(item => item.value ? this.options.matches(item, this.search.value) : !this.search.value.trim());
        log.debug('model-picker.filter', {operation: 'model-picker.filter', operationId: this.operationId, stage: 'catalog', result: 'success',
            terms: this.search.value.split(/[\s,，]+/u).filter(Boolean).length, visible: visible.length, total: choices.length, durationMs: Math.round(performance.now() - started)});
        this.status.textContent = t('connection.modelSearchCount', {visible: visible.filter(item => item.value).length, total: choices.filter(item => item.value).length});
        this.list.replaceChildren(...visible.map((choice, index) => this.row(choice, index)));
        this.active = Math.min(this.active, Math.max(0, visible.length - 1)); this.highlight();
    }
    private row(choice: ModelPickerChoice, index: number): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'option');
        button.id = `${this.list.id}-${index}`; button.disabled = !!choice.disabled;
        button.setAttribute('aria-selected', String(this.select.value === choice.value)); button.tabIndex = -1;
        const name = document.createElement('strong'); name.textContent = choice.name; button.append(name);
        if (choice.detail) {const detail = document.createElement('small'); detail.textContent = choice.detail; button.append(detail);}
        button.onclick = () => {
            log.debug('model-picker.select', {operation: 'model-picker.select', operationId: this.operationId, stage: 'selection', result: 'success', inherited: !choice.value, durationMs: 0});
            this.select.value = choice.value; this.sync(); this.dialog.close();
            this.select.dispatchEvent(new Event('change', {bubbles: true}));
        };
        return button;
    }
    private highlight(): void {
        this.list.querySelectorAll<HTMLElement>('[role=option]').forEach((row, index) => row.classList.toggle('is-highlighted', index === this.active));
        const row = this.list.children[this.active] as HTMLElement | undefined;
        if (row) this.search.setAttribute('aria-activedescendant', row.id); else this.search.removeAttribute('aria-activedescendant');
    }
    private keydown(event: KeyboardEvent): void {
        if (event.isComposing) return;
        const rows = [...this.list.querySelectorAll<HTMLButtonElement>('button')];
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1;
            for (let index = 0; index < rows.length; index++) {
                this.active = (this.active + step + rows.length) % rows.length;
                if (!rows[this.active].disabled) break;
            }
            this.highlight(); rows[this.active]?.scrollIntoView?.({block: 'nearest'});
        } else if (event.key === 'Enter' && event.target === this.search) {event.preventDefault(); rows[this.active]?.click();}
    }
    destroy(): void {this.abort.abort(); if (this.dialog.open) this.dialog.close(); this.dialog.remove(); this.trigger.remove(); this.select.hidden = false;}
}
