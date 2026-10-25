import type { ConversationMessage } from '@itookit/ui-common';
import type { SessionGroup } from '@itookit/llm-session/contracts';
import { createTranscriptMarkup } from './transcript-markup';
import { HistoryView } from '../components/HistoryView';
import { remoteRounds, remotePrompts, remoteCommandOutputs } from './remote-rounds';
import { ConversationHistoryNavigation } from './ConversationHistoryNavigation';
import type { ChatSubmission } from '../domain/submission';
import {NativeCommandOutputs} from '../components/history/NativeCommandOutputs';
import type {CommandOutputReader} from '../components/history/NativeCommandOutput';


/** Native snapshots use the same message renderer, copy and fold controls as local sessions. */
export class RemoteHistory {
    private readonly markup = createTranscriptMarkup();
    private groups: SessionGroup[] = [];
    private readonly outputs: NativeCommandOutputs;
    private closed = false;
    readonly view: HistoryView;
    readonly navigation: ConversationHistoryNavigation;
    constructor(private readonly container: HTMLElement, workspace: HTMLElement, header?: HTMLElement,
        navigation: {refresh?(): void; earlier?(): void} = {}, outputReader: CommandOutputReader = {}) {
        this.view = new HistoryView(container, {header, readOnly: true, htmlPolicy: 'literal', markdownPlugins: [this.markup.plugin],
            codeBlockControls: {defaultCollapsed: true, minLinesThreshold: 0, collapsedHeight: 0}});
        this.navigation = new ConversationHistoryNavigation(workspace, container, this.view, navigation);
        this.outputs = new NativeCommandOutputs(outputReader);
    }
    async show(messages: ConversationMessage[], submission?: ChatSubmission): Promise<void> {
        if (this.closed) return;
        this.markup.clear();
        const groups = remoteRounds(messages, this.markup.encode);
        this.groups = groups;
        this.view.setSubmission(submission);
        const anchor = this.container.querySelector<HTMLElement>('[data-session-id]');
        const top = anchor?.getBoundingClientRect().top;
        await this.view.renderSnapshot(groups); this.navigation.update(groups, remotePrompts(messages));
        if (this.closed) return;
        this.mountOutputs(messages);
        if (anchor?.isConnected && top !== undefined) this.container.scrollTop += anchor.getBoundingClientRect().top - top;
    }
    private mountOutputs(messages: ConversationMessage[]): void {
        const wrappers = new Map([...this.container.querySelectorAll<HTMLElement>('[data-session-id]')].map(item => [item.dataset.sessionId, item]));
        this.outputs.show(remoteCommandOutputs(messages).flatMap(item => {
            const parent = wrappers.get(item.groupId);
            return parent ? [{id: item.id, parent, output: item.output}] : [];
        }));
    }
    setActive(active: boolean): void {this.outputs.setActive(active);}
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
        this.closed = true; this.outputs.destroy(); this.navigation.destroy(); this.groups = []; this.markup.clear();
        return this.view.destroy();
    }
}
