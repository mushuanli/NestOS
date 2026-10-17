import { ACTION_ICONS, escapeHTML, t } from '@itookit/common';
import type { PromptNavigationItem } from '../PromptNavigator';
import { getPreviewText } from '../../utils/textUtils';

export const PromptNavigationTemplates = {
    shell: (): string => `
        <header class="llm-prompt-nav__header">
            <strong>${escapeHTML(t('chat.promptNav.title'))}</strong>
            <button type="button" data-action="close" aria-label="${escapeHTML(t('chat.promptNav.close'))}">${ACTION_ICONS.close}</button>
        </header>
        <input type="search" class="llm-prompt-nav__search" placeholder="${escapeHTML(t('chat.promptNav.search'))}" aria-label="${escapeHTML(t('chat.promptNav.search'))}" />
        <div class="llm-prompt-nav__tools">
            <div class="llm-prompt-nav__jumps">${(['first', 'middle', 'last'] as const).map(position => `<button type="button" data-jump="${position}">${escapeHTML(t(`chat.promptNav.${position}`))}</button>`).join('')}</div>
            <button type="button" data-action="preview" aria-pressed="false" title="${escapeHTML(t('chat.promptNav.preview'))}">${ACTION_ICONS.wordWrap}<span>${escapeHTML(t('chat.promptNav.preview'))}</span></button>
        </div>
        <nav class="llm-prompt-nav__list" aria-label="${escapeHTML(t('chat.promptNav.title'))}"></nav>
        <footer class="llm-prompt-nav__footer">
            <span class="llm-prompt-nav__range" role="status" aria-live="polite"></span>
            <button type="button" data-action="more" hidden>${escapeHTML(t('chat.promptNav.showMore'))}</button>
        </footer>
        <p class="llm-prompt-nav__scope" hidden></p>
        <button type="button" data-action="earlier" hidden></button>`,
    item: (item: PromptNavigationItem, ordinal: number, active: boolean): string => `
        <button type="button" class="llm-prompt-nav__item" data-prompt-id="${escapeHTML(item.id)}" ${active ? 'aria-current="location"' : ''}>
            <span class="llm-prompt-nav__number">${ordinal}</span>
            <span class="llm-prompt-nav__text">${escapeHTML(getPreviewText(item.text, 300) || t('chat.promptNav.attachment'))}</span>
        </button>`,
    empty: (key: 'chat.promptNav.empty' | 'chat.promptNav.noLoadedPrompts' | 'harness.loadingEarlier'): string => `<p class="llm-prompt-nav__empty">${escapeHTML(t(key))}</p>`,
};
