import {ACTION_ICONS, CHAT_ICONS} from '@itookit/common';
import {LayoutTemplates} from '../components/templates/LayoutTemplates';
import {ChatInputTemplates} from '../components/templates/ChatInputTemplates';

/** Reuse the product's existing icons without coupling the standalone view to NestOS. */
export function presentChatButton(node: HTMLButtonElement, action: string): void {
    const icons: Readonly<Record<string, string>> = {
        collapse: LayoutTemplates.collapseIcon(), collapseMessage: LayoutTemplates.collapseIcon(), refresh: ACTION_ICONS.refreshView, prompts: ACTION_ICONS.promptList,
        close: ACTION_ICONS.close, preview: ACTION_ICONS.wordWrap,
        search: CHAT_ICONS.search, copy: CHAT_ICONS.copy, edit: CHAT_ICONS.edit,
        retry: ACTION_ICONS.rerun, branch: ACTION_ICONS.branch, delete: ACTION_ICONS.delete, send: ChatInputTemplates.sendIcon(),
        attach: ChatInputTemplates.addIcon(), cancel: ChatInputTemplates.stopIcon(),
        print: '<i class="fas fa-print" aria-hidden="true"></i>',
    };
    const icon = icons[action]; if (!icon) return;
    node.innerHTML = icon;
    node.classList.add('llm-workspace-titlebar__btn');
    if (action === 'send' || action === 'attach') node.classList.add('llm-input__btn', `llm-input__btn--${action}`);
    if (action === 'cancel') node.classList.add('llm-input__btn--stop');
}

export function presentHostControl(node: HTMLElement, label: string, icon: string): void {
    node.title = label; node.setAttribute('aria-label', label);
    node.innerHTML = icon; node.classList.add('llm-workspace-titlebar__btn');
}
