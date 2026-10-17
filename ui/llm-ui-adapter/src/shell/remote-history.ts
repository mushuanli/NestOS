import type { ConversationMessage } from '@itookit/ui-common';
import type { SessionGroup } from '@itookit/llm-session/contracts';
import { createTranscriptMarkup } from './transcript-markup';
import { HistoryView } from '../components/HistoryView';
import { remoteRounds, remotePrompts } from './remote-rounds';
import { ConversationHistoryNavigation } from './ConversationHistoryNavigation';
import type { ChatSubmission } from '../domain/submission';


/** Native snapshots use the same message renderer, copy and fold controls as local sessions. */
export class RemoteHistory {
    private readonly markup = createTranscriptMarkup();
    private groups: SessionGroup[] = [];
    readonly view: HistoryView;
    readonly navigation: ConversationHistoryNavigation;
    constructor(private readonly container: HTMLElement, workspace: HTMLElement, header?: HTMLElement,
        navigation: {refresh?(): void; earlier?(): void} = {}) {
        this.view = new HistoryView(container, {header, readOnly: true, htmlPolicy: 'literal', markdownPlugins: [this.markup.plugin],
            codeBlockControls: {defaultCollapsed: true, minLinesThreshold: 0, collapsedHeight: 0}});
        this.navigation = new ConversationHistoryNavigation(workspace, container, this.view, navigation);
    }
    async show(messages: ConversationMessage[], submission?: ChatSubmission): Promise<void> {
        this.markup.clear();
        const groups = remoteRounds(messages, this.markup.encode);
        this.groups = groups;
        this.view.setSubmission(submission);
        const anchor = this.container.querySelector<HTMLElement>('[data-session-id]');
        const top = anchor?.getBoundingClientRect().top;
        await this.view.renderSnapshot(groups); this.navigation.update(groups, remotePrompts(messages));
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
    get markdownPlugin() { return this.markup.plugin; }
    markdown(): string { return this.groups.map(group => group.content ?? group.executionRoot?.data?.output ?? '').join('\n\n'); }
    destroy(): Promise<void> {
        this.navigation.destroy(); this.groups = []; this.markup.clear();
        return this.view.destroy();
    }
}
