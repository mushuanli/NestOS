import { copyText, Toast } from '@itookit/ui-common';
import type { SessionGroup } from '@itookit/llm-session/contracts';
import { FloatingNavPanel } from '../components/FloatingNavPanel';
import type { HistoryView } from '../components/HistoryView';
import { visibleSessionId } from '../components/history/visible-session';
import { getPreviewText } from '../utils/textUtils';
import { EditorEventBus } from './EditorEventBus';

/** Shared navigation presentation consumes rendered groups, without local Session commands. */
export class ConversationHistoryNavigation {
    private readonly bus = new EditorEventBus();
    private readonly panel: FloatingNavPanel;
    private groups: SessionGroup[] = [];
    constructor(workspace: HTMLElement, private readonly container: HTMLElement, private readonly view: HistoryView) {
        this.panel = new FloatingNavPanel(workspace, this.bus, undefined, true);
        this.bus.on('nav:scrollTo', ({sessionId}) => this.scrollTo(sessionId));
        this.bus.on('nav:toggleFold', ({sessionId}) => { view.toggleSessionCollapse(this.historyId(sessionId)); this.refresh(); });
        this.bus.on('nav:foldAll', () => { view.setAllCollapsed(true); this.refresh(); });
        this.bus.on('nav:unfoldAll', () => { view.setAllCollapsed(false); this.refresh(); });
        this.bus.on('batch:copy', ({ids}) => { void copyText(this.groups.filter(group => ids.includes(group.id)).map(group => group.content ?? group.executionRoot?.data.output ?? '').join('\n\n')).catch(error => Toast.error(String(error))); });
    }
    update(groups: SessionGroup[]): void { this.groups = groups; if (this.panel.isVisible) this.refresh(); }
    private refresh(): void {
        const states = this.view.getCollapseStates();
        this.panel.update({branches: [], currentSessionId: visibleSessionId(this.container), items: this.groups.map((group, index) => ({
            id: group.id, roundId: group.id, role: group.role, index, timestamp: group.timestamp,
            preview: getPreviewText(group.content ?? group.executionRoot?.data.output ?? '', 30),
            isCollapsed: states[group.executionRoot?.id ?? group.id] ?? false, agentName: group.executionRoot?.name,
        }))});
    }
    toggle(): void { this.refresh(); this.panel.toggle(); }
    navigate(direction: 'prev' | 'next'): void {
        const target = this.view.getUnfoldedNavigationTarget(direction);
        if (target === '__end__') this.view.scrollToBottom(true);
        else if (target === '__start__') this.container.scrollTo({top: 0, behavior: 'smooth'});
        else if (target) this.scrollTo(target);
    }
    private scrollTo(id: string): void {
        this.view.toggleSessionCollapse(this.historyId(id), false);
        this.view.getElement(id)?.scrollIntoView({block: 'start', behavior: 'smooth'});
    }
    private historyId(id: string): string { return this.groups.find(group => group.id === id)?.executionRoot?.id ?? id; }
    destroy(): void { this.panel.destroy(); this.bus.destroy(); }
}
