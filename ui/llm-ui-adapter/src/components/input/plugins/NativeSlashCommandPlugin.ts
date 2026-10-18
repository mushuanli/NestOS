import {t} from '@itookit/common';
import type {ConversationSlashCommand} from '@itookit/ui-common';
import type {InputPlugin, InputPluginContext} from './InputPlugin';
import {PopupPanel} from './PopupPanel';

/** Native catalogs supply suggestions; sending and acceptance stay with the controller. */
export class NativeSlashCommandPlugin implements InputPlugin {
    readonly id = 'native-slash-commands';
    readonly priority = 40;
    private context?: InputPluginContext;
    private panel?: PopupPanel;
    private generation = 0;
    private cached?: {at: number; commands: ConversationSlashCommand[]};
    private pending?: Promise<ConversationSlashCommand[]>;
    constructor(private readonly load: () => Promise<ConversationSlashCommand[]>) {}
    activate(context: InputPluginContext): void {
        this.context = context;
        this.panel = new PopupPanel(context.textarea, {variant: 'slash', maxVisible: 12, showSearch: false,
            emptyText: t('slash.panel.empty'), footerHint: t('slash.panel.footer')});
    }
    onInput(text: string): void {
        const generation = ++this.generation;
        if (!/^\/[^\s]*$/.test(text)) {this.cached = undefined; this.panel?.hide(); return;}
        void this.read().then(commands => {
            if (generation !== this.generation || !this.context) return;
            const query = text.slice(1).toLocaleLowerCase();
            this.panel?.show(commands.filter(command => !command.disabled && [command.name, command.description].join(' ').toLocaleLowerCase().includes(query))
                .map(command => ({id: command.name, label: '/' + command.name, description: command.description,
                    shortcut: command.argumentHint})), {onSelect: item => {
                    this.context?.setText('/' + item.id + ' '); this.context?.focus(); this.panel?.hide(); ++this.generation;
                }});
        }).catch(() => {if (generation === this.generation) this.panel?.hide();});
    }
    private read(): Promise<ConversationSlashCommand[]> {
        if (this.cached && Date.now() - this.cached.at < 1000) return Promise.resolve(this.cached.commands);
        if (this.pending) return this.pending;
        const pending = this.load().then(commands => {
            if (this.context) this.cached = {at: Date.now(), commands};
            return commands;
        }).finally(() => {if (this.pending === pending) this.pending = undefined;});
        this.pending = pending; return pending;
    }
    onKeyDown(event: KeyboardEvent): boolean {
        if (event.key === 'Escape' && this.context?.getText().startsWith('/')) {
            ++this.generation; this.panel?.hide(); event.preventDefault(); return true;
        }
        return this.panel?.isVisible ? this.panel.handleKeyDown(event) : false;
    }
    onBlur(): void {++this.generation; this.cached = undefined; this.panel?.hide();}
    deactivate(): void {++this.generation; this.cached = undefined; this.panel?.destroy(); this.panel = undefined; this.context = undefined;}
}
