import {ACTION_ICONS, getLocale, t} from '@itookit/common';
import {PromptNavigator as SharedPromptNavigator} from '@itookit/llm-ui';
export type {PromptNavigationItem} from '@itookit/llm-ui';

export interface PromptNavigationOptions {
    reveal(id: string): HTMLElement | null;
    refresh?(): void;
    earlier?(): void;
}
const labels: Record<string, Parameters<typeof t>[0]> = {
    prompts: 'chat.promptNav.title', promptClose: 'chat.promptNav.close', promptSearch: 'chat.promptNav.search',
    promptFirst: 'chat.promptNav.first', promptMiddle: 'chat.promptNav.middle', promptLast: 'chat.promptNav.last',
    promptPreview: 'chat.promptNav.preview', promptMore: 'chat.promptNav.showMore', promptLoadedOnly: 'chat.promptNav.loadedOnly',
    promptAttachment: 'chat.promptNav.attachment', promptEmpty: 'chat.promptNav.empty', promptNoLoaded: 'chat.promptNav.noLoadedPrompts',
    promptLoading: 'harness.loadingEarlier', earlier: 'harness.earlierHistory',
    promptCount: 'chat.promptNav.count',
};
/** Project only host identities and labels into the shared navigation component. */
export class PromptNavigator extends SharedPromptNavigator {
    constructor(workspace: HTMLElement, history: HTMLElement, options: PromptNavigationOptions) {
        super({...options, root: workspace, history, trigger: workspace.querySelectorAll<HTMLButtonElement>('#llm-btn-prompt-nav')[0]!,
            locale: getLocale(), translate: (key, parameters) => labels[key] ? t(labels[key], parameters) : undefined,
            presentButton: (button, action) => {
                if (action === 'close') button.innerHTML = ACTION_ICONS.close;
                if (action === 'preview') button.insertAdjacentHTML('afterbegin', ACTION_ICONS.wordWrap);
            },
            getRows: () => [...history.querySelectorAll<HTMLElement>('.llm-ui-session[data-session-id]')]
                .map(element => ({id: element.dataset.sessionId!, element})),
        });
    }
}
