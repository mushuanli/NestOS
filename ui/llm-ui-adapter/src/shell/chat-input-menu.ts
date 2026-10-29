import {CHAT_ICONS, ENTITY_ICONS, getLocale, t} from '@itookit/common';
import {PopupPanel, type ChatView, type MountedToolbar} from '@itookit/llm-ui';
import {ChatInputTemplates} from '../components/templates/ChatInputTemplates';
import {HelpPanel} from '../components/input/HelpPanel';
import type {ChatInputSettings} from '../domain/ports/IChatInputPresenter';

interface Options {
    view: ChatView;
    settings(): ChatInputSettings;
    prompts(): readonly {name?: string; prompt: string}[];
    agentId(): string | undefined;
    configureAgent?(id: string): void | Promise<void>;
    available(): boolean;
    report(error: unknown): void;
    hasFiles?: boolean;
}
/** Product actions reuse the retained input and the existing help/candidate mechanisms. */
export function mountChatInputMenu(root: HTMLElement, options: Options): MountedToolbar {return new ChatInputMenu(root, options);}
class ChatInputMenu implements MountedToolbar {
    private readonly host = document.createElement('div');
    private readonly helpHost = document.createElement('div');
    private readonly help: HelpPanel;
    private readonly search: HTMLButtonElement;
    private readonly configure: HTMLButtonElement;
    private readonly prompts: HTMLButtonElement;
    private popup?: PopupPanel;
    private closed = false;
    private readonly escape = (event: KeyboardEvent) => {if (event.key === 'Escape') this.help.hide();};
    constructor(private root: HTMLElement, private options: Options) {
        this.host.className = 'llm-chat__menu-actions'; this.helpHost.className = 'llm-chat__help-host';
        this.helpHost.innerHTML = ChatInputTemplates.renderHelpPanel();
        this.helpHost.querySelector<HTMLButtonElement>('.llm-input__help-close')!.type = 'button';
        options.view.inputContext().container.prepend(this.helpHost); root.append(this.host);
        this.help = new HelpPanel(this.helpHost, {hasFiles: () => !!options.hasFiles, onCloseSettings: () => {
            const details = root.querySelector<HTMLDetailsElement>('[data-chat-settings]'); if (details) details.open = false;
        }});
        this.search = action(this.host, 'websearch', t('webSearch.label'), CHAT_ICONS.search, () => this.toggleSearch());
        this.configure = action(this.host, 'configure-agent', t('chatInput.configureAgent'), ENTITY_ICONS.agent, () => this.configureAgent());
        this.prompts = action(this.host, 'prompts', t('chatInput.prompts'), CHAT_ICONS.edit, () => this.showPrompts());
        action(this.host, 'help', t('chatInput.help'), ChatInputTemplates.helpIcon(), event => this.showHelp(event));
        document.addEventListener('keydown', this.escape); this.update();
    }
    private available(): boolean {return !this.closed && this.options.available();}
    private toggleSearch(): void {
        if (!this.available()) return;
        const draft = this.options.view.getDraft();
        this.options.view.configureInput({selection: {...draft.selection, webSearchEnabled: String(!(this.options.settings().webSearchEnabled ?? true))}}, draft.revision); this.update();
    }
    private configureAgent(): void {
        const id = this.options.agentId(); if (!id || !this.available()) return;
        void this.options.view.flushDraft().then(() => {
            if (this.available()) return this.options.configureAgent?.(id);
        }).catch(this.options.report);
    }
    private showPrompts(): void {
        if (!this.available()) return;
        const captured = this.options.prompts();
        this.popup ??= new PopupPanel(this.prompts, {locale: getLocale(), showSearch: true, maxVisible: Number.POSITIVE_INFINITY});
        this.popup.show(captured.map((item, index) => ({id: String(index), label: item.name ?? item.prompt.slice(0, 40),
            icon: CHAT_ICONS.edit, description: item.prompt.replace(/\s+/g, ' ').slice(0, 60)})), {onSelect: item => {
            if (!this.available()) return;
            const value = captured[Number(item.id)]; if (!value) return;
            this.options.view.inputContext().insertAtCursor(value.prompt); this.options.view.focus();
        }});
    }
    private showHelp(event: MouseEvent): void {
        event.stopPropagation(); const menu = this.root.closest<HTMLDetailsElement>('.llm-chat__input-menu'); if (menu) menu.open = false;
        this.help.show();
    }
    update(): void {
        this.search.setAttribute('aria-pressed', String(this.options.settings().webSearchEnabled ?? true)); this.search.disabled = !this.available();
        this.configure.hidden = !this.options.configureAgent || !this.options.agentId(); this.configure.disabled = !this.available();
        this.prompts.hidden = !this.options.prompts().length; this.prompts.disabled = !this.available();
    }
    destroy(): void {
        if (this.closed) return; this.closed = true; document.removeEventListener('keydown', this.escape);
        this.popup?.destroy(); this.help.destroy(); this.helpHost.remove(); this.host.remove();
    }
}

function action(root: HTMLElement, id: string, label: string, icon: string, run: (event: MouseEvent) => void): HTMLButtonElement {
    const button = document.createElement('button'), text = document.createElement('span'); button.type = 'button';
    button.className = 'llm-chat__menu-action'; button.dataset.inputAction = id;
    button.innerHTML = icon; text.textContent = label; button.append(text); button.setAttribute('aria-label', label);
    button.addEventListener('click', run); root.append(button); return button;
}
