import {DisclosureController, type DisclosureEntry} from '@itookit/llm-ui';
import type {CollapseStateMap} from '../../domain/types';
import type {SessionRenderer} from './SessionRenderer';
import type {IEditorEventBus} from '../../domain/events';
import {LayoutTemplates} from '../templates/LayoutTemplates';

/** NestOS projects legacy cards and lazy Markdown activation into shared disclosure mechanics. */
export class CollapseController {
    private readonly disclosure: DisclosureController;
    constructor(private readonly container: HTMLElement, private readonly renderer: SessionRenderer, bus?: IEditorEventBus, initialStates?: CollapseStateMap) {
        this.disclosure = new DisclosureController(container, {initialStates, entries: () => this.entries(),
            onReveal: entry => renderer.activateVisibleEditors(entry?.element),
            onChange: states => bus?.emit('state:collapseChanged', {states}),
            present: (entry, collapsed) => {const svg = entry.trigger?.querySelector('svg'); if (svg) svg.innerHTML = collapsed ? LayoutTemplates.chevronDown() : LayoutTemplates.chevronUp();}});
    }
    getStates(): CollapseStateMap {return this.disclosure.getStates();}
    setState(id: string, collapsed: boolean): void {this.disclosure.setState(id, collapsed);}
    resetStates(): void {this.disclosure.resetStates();}
    computeInitialState(id: string, role: string, index: number, totalCount: number): boolean {
        return this.disclosure.initialState(id, role === 'user' || index < totalCount - 1);
    }
    toggle(element: HTMLElement, trigger: HTMLElement, id: string, streaming: boolean): boolean {
        return this.disclosure.toggle({id, element, trigger}, undefined, !streaming);
    }
    toggleSession(id: string, force?: boolean): boolean {
        const session = this.renderer.getSessionElement(id) ?? this.renderer.getNode(id); if (!session) return false;
        const element = session.matches('.llm-ui-flow-window, .llm-ui-node') ? session : session.querySelector<HTMLElement>('.llm-ui-bubble--user, .llm-ui-node');
        if (!element) return false;
        const entry = this.entry(element, id); if (force === this.disclosure.isCollapsed(entry)) return false;
        return this.disclosure.toggle(entry, force);
    }
    private entry(element: HTMLElement, id: string): DisclosureEntry {
        return {id, element, trigger: element.querySelector<HTMLElement>('[data-action="collapse"]') ?? undefined};
    }
    private entries(): DisclosureEntry[] {
        const entries = new Map<string, DisclosureEntry>();
        for (const element of this.container.querySelectorAll<HTMLElement>('.llm-ui-bubble--user, .llm-ui-node, .llm-ui-flow-window')) {
            const id = element.dataset.historyId || element.dataset.id || element.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
            if (id) entries.set(id, this.entry(element, id));
        }
        for (const session of this.container.querySelectorAll<HTMLElement>('[data-session-id]')) {
            const element = session.querySelector<HTMLElement>('.llm-ui-bubble--user, .llm-ui-node, .llm-ui-flow-window');
            if (element && session.dataset.sessionId && !entries.has(session.dataset.sessionId)) entries.set(session.dataset.sessionId, this.entry(element, session.dataset.sessionId));
        }
        return [...entries.values()];
    }
    setAllCollapsed(collapsed: boolean): void {this.disclosure.setAllCollapsed(collapsed);}
    findUnfoldedByViewport(direction: 'current' | 'prev' | 'next', roleFilter: string | null = null): string | null {
        const entries: DisclosureEntry[] = [];
        for (const element of this.container.querySelectorAll<HTMLElement>('.llm-ui-session, [data-history-id]')) {
            if (element.classList.contains('llm-ui-session') && element.querySelector('.llm-ui-flow-window')) continue;
            const id = element.dataset.historyId || element.dataset.sessionId;
            if (!id || element.classList.contains('is-collapsed')) continue;
            if (roleFilter && !element.classList.contains(`llm-ui-session--${roleFilter}`) && element.dataset.role !== roleFilter) continue;
            entries.push({id, element});
        }
        const found = this.disclosure.findUnfoldedByViewport(direction, entries);
        return found?.kind === 'item' ? found.id : found ? `__${found.kind}__` : null;
    }
    foldCurrentUnfolded(): void {const id = this.findUnfoldedByViewport('current'); if (id && id !== '__start__' && id !== '__end__') this.toggleSession(id, true);}
    shouldCollapse(): boolean {
        return [...this.container.querySelectorAll('.llm-ui-session--assistant .llm-ui-node, .llm-ui-flow-window[data-role="assistant"]')]
            .some(node => !node.classList.contains('is-collapsed') && !node.parentElement?.closest('.is-collapsed'));
    }
    toggleAll(): boolean {const collapsed = this.shouldCollapse(); this.setAllCollapsed(collapsed); return collapsed;}
    async collapseCodeBlocksInSession(sessionId: string): Promise<void> {
        const ids = this.renderer.getEditorIdsForSession(sessionId);
        await Promise.all(ids.map(async (id) => {
            const ctrl = this.renderer.getEditor(id);
            if (ctrl && this.renderer.isEditorVisible(id)) {
                try {
                    await ctrl.waitUntilReady();
                    await ctrl.collapseBlocks();
                } catch (e) {
                    console.warn(`[CollapseController] Code block collapse failed: ${id}`, e);
                }
            }
        }));
    }

    async batchCodeBlockAction(action: 'collapse' | 'expand'): Promise<void> {
        const promises: Promise<void>[] = [];
        this.renderer.editors.forEach((ctrl, id) => {
            promises.push((async () => {
                try {
                    await ctrl.waitUntilReady();
                    action === 'collapse' ? await ctrl.collapseBlocks() : await ctrl.expandBlocks();
                } catch (e) {
                    console.warn(`[CollapseController] ${action} failed: ${id}`, e);
                }
            })());
        });
        await Promise.all(promises);
    }

    destroy(): void {this.disclosure.destroy();}
}
