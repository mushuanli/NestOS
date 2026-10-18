import type {ComposerCommand} from './contracts';
import {button, element} from './dom';
import {parseCommand} from './commands';
import type {Translate} from './i18n';

/** Completion inserts text and a stable target; only an explicit submit executes it. */
export class CommandPicker {
    readonly element = element('div', 'llm-chat__commands');
    private commands: readonly ComposerCommand[] = [];
    private chosen?: {id: string; revision: number; name: string};
    private active = true;
    private index = 0;
    constructor(private readonly input: HTMLTextAreaElement, private readonly insert: (text: string) => void, private readonly t: Translate) {
        this.element.hidden = true; this.element.setAttribute('role', 'listbox');
        this.element.addEventListener('mousedown', event => event.preventDefault());
        this.input.addEventListener('blur', () => {this.element.hidden = true;});
    }
    update(commands: readonly ComposerCommand[]): void {this.commands = commands; if (!this.element.hidden) this.refresh();}
    refresh(): void {
        const match = this.input.value.match(/^\/([\p{L}\p{N}_:.-]*)$/u);
        if (this.chosen && parseCommand(this.input.value)?.name !== this.chosen.name) this.chosen = undefined;
        const query = match?.[1].toLocaleLowerCase();
        this.element.replaceChildren(); this.index = 0;
        this.element.hidden = !this.active || query === undefined;
        if (this.element.hidden) return;
        const rows = this.commands.filter(command => !command.disabled && [command.name, command.description, command.source.label]
            .join(' ').toLocaleLowerCase().includes(query!));
        for (const command of rows.slice(0, 30)) {
            const row = button(`/${command.name} · ${command.source.label} — ${command.description}`, () => this.choose(command));
            row.dataset.commandId = command.id; row.setAttribute('role', 'option'); this.element.append(row);
        }
        this.highlight();
    }
    private choose(command: ComposerCommand): void {
        this.chosen = {id: command.id, revision: command.revision, name: command.name};
        this.insert('/' + command.name + ' '); this.element.hidden = true; this.input.focus();
    }
    key(event: KeyboardEvent): boolean {
        if (this.element.hidden || event.isComposing || event.keyCode === 229) return false;
        const rows = [...this.element.querySelectorAll<HTMLButtonElement>('button')];
        if (event.key === 'Escape') this.element.hidden = true;
        else if (rows.length && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
            this.index = (this.index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; this.highlight();
        } else if (rows.length && ['Tab', 'Enter'].includes(event.key)) rows[this.index].click();
        else return false;
        event.preventDefault(); return true;
    }
    private highlight(): void {
        [...this.element.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === this.index)));
    }
    resolve(text: string): {command: ComposerCommand; arguments: string} | undefined {
        const parsed = parseCommand(text); if (!parsed) return;
        const rows = this.commands.filter(command => command.name === parsed.name && !command.disabled);
        const target = this.chosen?.name === parsed.name ? rows.find(row => row.id === this.chosen!.id && row.revision === this.chosen!.revision)
            : rows.length === 1 ? rows[0] : undefined;
        if (!target) throw new Error(rows.length > 1 ? this.t('commandAmbiguous') : this.t('commandUnavailable'));
        return {command: target, arguments: parsed.arguments};
    }
    setActive(active: boolean): void {this.active = active; if (!active) this.element.hidden = true;}
}
