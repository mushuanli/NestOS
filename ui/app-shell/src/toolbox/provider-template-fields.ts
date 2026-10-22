import { randomUUID, t } from '@itookit/common';
import '../styles/toolbox-create.css';

type Template = { id: string; name: string };

/** Catalog names use their template; other names create a custom provider. */
class ProviderTemplatePicker {
    readonly field = document.createElement('div');
    private readonly input = document.createElement('input');
    private readonly list = document.createElement('div');
    private readonly help = document.createElement('small');
    private selected = '';
    private active = -1;
    constructor(private readonly templates: readonly Template[], initialName = '', private readonly existing: readonly Template[] = []) {
        this.field.className = 'toolbox-create__provider';
        const label = document.createElement('label'), id = 'provider-template-' + randomUUID();
        label.textContent = t('provider.template.label'); label.htmlFor = this.input.id = id;
        this.input.name = 'providerTemplateSearch'; this.input.type = 'search'; this.input.autocomplete = 'off'; this.input.required = true;
        this.input.value = initialName; this.selected = this.resolve()?.id ?? '';
        this.input.placeholder = t('provider.template.search'); this.input.setAttribute('role', 'combobox');
        this.input.setAttribute('aria-autocomplete', 'list'); this.input.setAttribute('aria-controls', this.list.id = id + '-list');
        this.input.setAttribute('aria-describedby', this.help.id = id + '-help');
        this.list.className = 'toolbox-create__options'; this.list.setAttribute('role', 'listbox');
        this.list.setAttribute('aria-label', t('provider.template.label')); this.list.hidden = true;
        this.describe();
        this.field.append(label, this.input, this.list, this.help); this.bind(); this.close(); this.validate(false);
    }
    templateId(): string | undefined { return this.resolve()?.id; }
    providerName(): string { return this.resolve()?.name ?? this.input.value.trim(); }
    setVisible(visible: boolean): void { this.field.hidden = !visible; this.input.disabled = !visible; if (!visible) this.close(); }
    focus(): void { this.input.focus(); }
    validate(report = true): boolean {
        this.input.setCustomValidity(!this.input.value.trim() ? t('provider.template.required') : this.exists(this.resolve()) ? t('provider.template.exists') : '');
        return !report || this.input.reportValidity();
    }
    private bind(): void {
        this.input.onfocus = () => this.render(); this.input.onclick = () => this.render();
        this.input.oninput = () => { this.selected = this.resolve()?.id ?? ''; this.validate(false); this.describe(); this.render(); };
        this.input.onkeydown = event => this.keydown(event);
        this.field.addEventListener('focusout', event => { if (!this.field.contains(event.relatedTarget as Node | null)) this.close(); });
        this.list.onpointerdown = event => event.preventDefault();
        this.list.onclick = event => {
            const button = (event.target as Element).closest<HTMLButtonElement>('[data-template-id]');
            if (button) this.choose(button.dataset.templateId!);
        };
    }
    private render(): void {
        const query = this.selected ? '' : this.input.value.trim().toLocaleLowerCase();
        const visible = this.templates.filter(item => `${item.id} ${item.name}`.toLocaleLowerCase().includes(query));
        this.list.replaceChildren(...visible.map(item => this.option(item)));
        if (!visible.length) {
            const empty = document.createElement('div'); empty.className = 'toolbox-create__empty';
            empty.setAttribute('role', 'status'); empty.textContent = t('provider.template.empty'); this.list.append(empty);
        }
        if (!this.resolve()) {
            const custom = this.option({ id: 'custom', name: this.input.value.trim()
                ? t('provider.template.useCustom', { name: this.input.value.trim() }) : t('provider.template.custom') });
            custom.classList.add('toolbox-create__custom'); this.list.append(custom);
        }
        this.list.hidden = false; this.input.setAttribute('aria-expanded', 'true'); this.activate(-1);
    }
    private option(item: Template): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
        button.className = 'toolbox-create__option'; button.dataset.templateId = item.id;
        button.id = this.list.id + '-' + this.templates.findIndex(template => template.id === item.id);
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(this.selected === item.id));
        button.disabled = item.id !== 'custom' && this.exists(item);
        button.setAttribute('aria-disabled', String(button.disabled));
        button.textContent = item.name + (button.disabled ? ` · ${t('provider.template.added')}` : ''); return button;
    }
    private choose(id: string): void {
        const next = this.templates.find(item => item.id === id);
        if (next && this.exists(next)) return;
        this.selected = next?.id ?? ''; if (next) this.input.value = next.name;
        this.describe();
        this.validate(false); this.close();
        if (!this.input.value.trim()) this.input.focus();
    }
    private resolve(): Template | undefined {
        const query = this.input.value.trim().toLocaleLowerCase();
        return this.templates.find(item => item.name.toLocaleLowerCase() === query || item.id.toLocaleLowerCase() === query);
    }
    private exists(template?: Template): boolean {
        const name = (template?.name ?? this.input.value).trim().toLocaleLowerCase();
        return this.existing.some(provider => provider.id === template?.id || provider.name.trim().toLocaleLowerCase() === name);
    }
    private describe(): void {
        this.help.textContent = t(this.exists(this.resolve()) ? 'provider.template.exists' : !this.resolve() && this.input.value.trim() ? 'provider.template.customHelp' : 'provider.template.help');
    }
    private keydown(event: KeyboardEvent): void {
        if (event.isComposing || event.keyCode === 229) return;
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); this.move(event.key === 'ArrowDown' ? 1 : -1); }
        else if (event.key === 'Enter') this.enter(event);
        else if (event.key === 'Escape' && !this.list.hidden) {
            event.preventDefault(); event.stopPropagation(); this.close();
        } else if (event.key === 'Tab') this.close();
    }
    private move(direction: number): void {
        if (this.list.hidden) this.render();
        const count = this.list.querySelectorAll('[role="option"]:not(:disabled)').length;
        if (!count) return;
        this.activate(this.active < 0 ? direction > 0 ? 0 : count - 1 : (this.active + direction + count) % count);
    }
    private enter(event: KeyboardEvent): void {
        if (this.list.hidden || this.active < 0) return;
        event.preventDefault(); this.choose(this.list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')[this.active].dataset.templateId!);
    }
    private activate(index: number): void {
        this.active = index;
        const options = this.list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)');
        options.forEach((option, i) => { option.dataset.active = String(i === index); });
        if (index >= 0) { this.input.setAttribute('aria-activedescendant', options[index].id); options[index].scrollIntoView?.({ block: 'nearest' }); }
        else this.input.removeAttribute('aria-activedescendant');
    }
    private close(): void { this.list.hidden = true; this.input.setAttribute('aria-expanded', 'false'); this.activate(-1); }
}

/** Provider naming stays inside the searchable catalog field. */
export function providerTemplateFields(templates: readonly Template[], initialName?: string, existing?: readonly Template[]) { return new ProviderTemplatePicker(templates, initialName, existing); }
