import type { ConversationMessage } from '@itookit/ui-common';
import type { MDxPlugin } from '@itookit/mdxeditor';
import { HistoryView } from '../components/HistoryView';
import { remoteRounds } from './remote-rounds';
import { ConversationHistoryNavigation } from './ConversationHistoryNavigation';
import type { ChatSubmission } from '../domain/submission';

export const literalHtml: MDxPlugin = {name: 'native-literal-html', install(context) {
    context.registerSyntaxExtension({renderer: {html(token) {
        return token.text.replace(/[&<>]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[char]!));
    }}});
}};

/** Native snapshots use the same message renderer, copy and fold controls as local sessions. */
export class RemoteHistory {
    readonly view: HistoryView;
    readonly navigation: ConversationHistoryNavigation;
    constructor(private readonly container: HTMLElement, workspace: HTMLElement, header?: HTMLElement) {
        this.view = new HistoryView(container, {header, readOnly: true, markdownPlugins: [literalHtml],
            codeBlockControls: {defaultCollapsed: true, minLinesThreshold: 0, collapsedHeight: 0}});
        this.navigation = new ConversationHistoryNavigation(workspace, container, this.view);
    }
    async show(messages: ConversationMessage[], submission?: ChatSubmission): Promise<void> {
        const groups = remoteRounds(messages);
        this.view.setSubmission(submission);
        const anchor = this.container.querySelector<HTMLElement>('[data-session-id]');
        const top = anchor?.getBoundingClientRect().top;
        await this.view.renderSnapshot(groups); this.navigation.update(groups);
        if (anchor?.isConnected && top !== undefined) this.container.scrollTop += anchor.getBoundingClientRect().top - top;
    }
    locate(itemId: string, messages: ConversationMessage[]): boolean {
        const index = messages.findIndex(message => message.id === itemId);
        if (index < 0) return false;
        const group = remoteRounds(messages.slice(0, index + 1)).at(-1);
        const element = [...this.container.querySelectorAll<HTMLElement>('[data-session-id]')].find(row => row.dataset.sessionId === group?.id);
        if (!element) return false;
        element.scrollIntoView?.({block: 'center'}); element.classList.add('llm-ui-search-hit');
        element.tabIndex = -1; element.focus({preventScroll: true}); return true;
    }
    destroy(): Promise<void> { this.navigation.destroy(); return this.view.destroy(); }
}
