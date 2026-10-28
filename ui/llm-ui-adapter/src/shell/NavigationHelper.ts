// @file: llm-ui/shell/NavigationHelper.ts
// Navigation + floating panel logic — extracted from LLMWorkspaceEditor.
// Handles: viewport-aware session finding, scroll-to navigation, and the floating nav panel.


import { SessionCommand, type SessionGroup } from '@itookit/llm-session/contracts';
import type { IHistoryPresenter } from '../domain/ports/IHistoryPresenter';
import type { INavigationPresenter, NavPanelData } from '../domain/ports/INavigationPresenter';
import type { IEditorEventBus } from '../domain/events';
import type { ICommandBus } from '@itookit/llm-session/contracts';

import type { IBranchStore } from '../domain/ports/IBranchStore';
import type { NavDataBuilder } from '../services/NavDataBuilder';
import type {DOMCache} from '@itookit/llm-ui';
import type {TimerManager} from '@itookit/llm-ui';
import { FloatingNavPanel } from '../components/FloatingNavPanel';
import { Toast } from '@itookit/ui-common';
import { visibleSessionId } from '../components/history/visible-session';
import { PromptNavigator } from '../components/PromptNavigator';

export interface NavigationDeps {
    workspace: HTMLElement;
    domCache: DOMCache;
    commands: ICommandBus;
    historyView: IHistoryPresenter;
    bus: IEditorEventBus;
    branchStore: IBranchStore;
    navDataBuilder: NavDataBuilder;
    timers: TimerManager;
}

export class NavigationHelper {
    private floatingNav: INavigationPresenter | null = null;
    private navRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly prompts: PromptNavigator;
    private sessions: SessionGroup[] = [];
    private historyDirty = true;
    private historyRevision = 0;
    private historyRead?: Promise<SessionGroup[]>;
    private destroyed = false;

    constructor(private deps: NavigationDeps) {
        this.prompts = new PromptNavigator(deps.workspace, deps.domCache.byId('llm-ui-history')!, {
            refresh: () => this.refreshPrompts(),
            reveal: id => deps.historyView.revealSession(id),
        });
    }

    private refreshPrompts(): void {
        if (!this.historyRead) this.invalidateHistory();
        void this.loadSessions().catch(error => { if (!this.destroyed) Toast.error(String(error)); });
    }

    updatePrompts(sessions: SessionGroup[]): void {
        if (this.destroyed) return;
        this.historyRevision++; this.historyDirty = false; this.sessions = sessions;
        this.prompts.update(sessions.filter(session => session.role === 'user').map(session => ({id: session.id, text: session.content ?? ''})));
    }

    private invalidateHistory(): void { this.historyRevision++; this.historyDirty = true; }

    private loadSessions(): Promise<SessionGroup[]> {
        if (!this.historyDirty || this.destroyed) return Promise.resolve(this.sessions);
        return this.historyRead ??= this.readSessions().finally(() => { this.historyRead = undefined; });
    }

    private async readSessions(): Promise<SessionGroup[]> {
        while (this.historyDirty && !this.destroyed) {
            const revision = this.historyRevision;
            try {
                const sessions = await this.deps.commands.execute<SessionGroup[]>(SessionCommand.GetSessions);
                if (revision === this.historyRevision) this.updatePrompts(sessions);
            } catch (error) { if (revision === this.historyRevision) throw error; }
        }
        return this.sessions;
    }

    get isNavVisible(): boolean {
        return this.floatingNav?.isVisible ?? false;
    }

    // ── Viewport-aware session finding ──────────────────────────────────────

    findCurrentVisibleSession(): string | null {
        const historyEl = this.deps.domCache.byId('llm-ui-history');
        return historyEl ? visibleSessionId(historyEl) ?? null : null;
    }

    updateActiveSessionHighlight(): void {
        const currentId = this.findCurrentVisibleSession();
        if (!currentId) return;

        const historyEl = this.deps.domCache.byId('llm-ui-history');
        if (!historyEl) return;

        const prev = historyEl.querySelector('.llm-ui-session.is-active');
        if (prev && (prev as HTMLElement).dataset.sessionId === currentId) return;
        prev?.classList.remove('is-active');

        const el = historyEl.querySelector(`[data-session-id="${currentId}"]`);
        el?.classList.add('is-active');
    }

    navigateToUserChat(direction: 'prev' | 'next'): void {
        const currentId = this.findCurrentVisibleSession();
        if (!currentId) return;

        this.loadSessions().then(sessions => {
            if (this.destroyed) return;
            const idx = sessions.findIndex(s => s.id === currentId);
            const step = direction === 'prev' ? -1 : 1;

            for (let i = idx + step; i >= 0 && i < sessions.length; i += step) {
                if (sessions[i].role === 'user') {
                    this.deps.bus.emit('nav:scrollTo', { sessionId: sessions[i].id });
                    return;
                }
            }
        }).catch(() => {});
    }

    navigateUnfolded(direction: 'prev' | 'next'): void {
        const result = this.deps.historyView.getUnfoldedNavigationTarget(direction);

        if (result === '__end__') {
            this.deps.historyView.scrollToBottom(true);
        } else if (result === '__start__') {
            const historyEl = this.deps.domCache.byId('llm-ui-history');
            historyEl?.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (result) {
            this.deps.bus.emit('nav:scrollTo', { sessionId: result });
        } else {
            Toast.info(direction === 'prev'
                ? 'No previous unfolded chat'
                : 'Already at the last unfolded chat');
        }
    }

    // ── Floating nav panel ──────────────────────────────────────────────────

    pushNavData(): void {
        this.invalidateHistory();
        if (this.destroyed || (!this.prompts.isVisible && !this.isNavVisible)) return;
        if (this.navRefreshTimer !== null) this.deps.timers.clearTimeout(this.navRefreshTimer);
        this.navRefreshTimer = this.deps.timers.setTimeout(() => {
            this.navRefreshTimer = null;
            if (this.destroyed || (!this.prompts.isVisible && !this.isNavVisible)) return;
            void this.refreshVisibleNavigation().catch(error => { if (!this.destroyed) Toast.error(String(error)); });
        }, 50);
    }

    private async refreshVisibleNavigation(): Promise<void> {
        await this.loadSessions();
        if (this.destroyed || !this.isNavVisible) return;
        const data = await this.buildNavData();
        if (!this.destroyed && this.isNavVisible && data) this.floatingNav?.update(data);
    }

    async pushNavDataImmediate(): Promise<void> {
        if (!this.floatingNav) return;

        if (this.navRefreshTimer !== null) {
            this.deps.timers.clearTimeout(this.navRefreshTimer);
            this.navRefreshTimer = null;
        }

        const data = await this.buildNavData();
        if (!this.destroyed && data) this.floatingNav?.update(data);
    }

    private async buildNavData(): Promise<NavPanelData | undefined> {
        const sessions = await this.loadSessions();
        const revision = this.historyRevision;
        const data = await this.deps.navDataBuilder.build(
            sessions,
            this.deps.historyView.getCollapseStates(),
            this.deps.branchStore.current,
            this.findCurrentVisibleSession() ?? undefined
        );
        return revision === this.historyRevision ? data : undefined;
    }

    async toggleNavigator(container: HTMLElement): Promise<void> {
        if (!this.floatingNav) {
            this.floatingNav = new FloatingNavPanel(
                container,
                this.deps.bus as any,
                {
                    onSetContext: async (roundIds, mode) => {
                        await this.deps.commands.execute(SessionCommand.ContextSet, {
                            roundIds,
                            mode,
                            scope: 'subtree',
                        });
                    },
                },
            );
        }

        if (!this.floatingNav.isVisible) {
            if (!this.historyRead) this.invalidateHistory();
            await this.pushNavDataImmediate();
        }

        if (!this.destroyed) this.floatingNav?.toggle();
    }

    destroy(): void {
        this.destroyed = true; this.historyRevision++; this.sessions = []; this.prompts.destroy();
        this.floatingNav?.destroy();
        this.floatingNav = null;
        if (this.navRefreshTimer !== null) {
            this.deps.timers.clearTimeout(this.navRefreshTimer);
            this.navRefreshTimer = null;
        }
    }
}
