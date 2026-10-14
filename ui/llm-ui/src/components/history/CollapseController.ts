// @file: llm-ui/components/history/CollapseController.ts

import { CollapseStateMap } from '../../domain/types';
import type { SessionRenderer } from './SessionRenderer';
import type { IEditorEventBus } from '../../domain/events';
import { LayoutTemplates } from '../templates/LayoutTemplates';

/**
 * 折叠状态控制器
 *
 * 职责：
 * 1. 管理 session/node 折叠状态
 * 2. 计算初始折叠状态
 * 3. 操作 DOM 折叠/展开
 * 4. 视口感知的 unfold chat 查找（统一 fold/navigate 逻辑）
 * 5. 触发代码块折叠
 * 6. 通知状态持久化
 *
 * 不负责：编辑模式、流式更新
 */
export class CollapseController {
    private states: CollapseStateMap = {};

    private static readonly TITLE_HEIGHT = 48;

    constructor(
        private container: HTMLElement,
        private renderer: SessionRenderer,
        private bus?: IEditorEventBus,
        initialStates?: CollapseStateMap
    ) {
        if (initialStates) {
            this.states = { ...initialStates };
        }
    }

    // ================================================================
    // 状态访问
    // ================================================================

    getStates(): CollapseStateMap {
        return { ...this.states };
    }

    setState(id: string, collapsed: boolean): void {
        this.states[id] = collapsed;
    }

    resetStates(): void {
        this.states = {};
    }

    /**
     * 计算 session 的初始折叠状态
     */
    computeInitialState(
        sessionId: string,
        role: string,
        index: number,
        totalCount: number
    ): boolean {
        if (this.states[sessionId] !== undefined) {
            return this.states[sessionId];
        }

        const shouldCollapse = role === 'user' ? true : (index < totalCount - 1);
        this.states[sessionId] = shouldCollapse;
        return shouldCollapse;
    }

    // ================================================================
    // 单项折叠
    // ================================================================

    /**
     * 切换折叠（由事件委托触发）
     *
     * @returns true 如果从折叠变为展开（需要触发代码块折叠）
     */
    toggle(
        element: HTMLElement,
        btn: HTMLElement,
        sessionId: string,
        isStreaming: boolean
    ): boolean {
        const wasCollapsed = element.classList.contains('is-collapsed');
        element.classList.toggle('is-collapsed');
        const isCollapsed = element.classList.contains('is-collapsed');
        if (!isCollapsed) this.renderer.activateVisibleEditors(element);

        this.updateChevron(btn, isCollapsed);
        this.states[sessionId] = isCollapsed;

        if (!isStreaming) {
            this.notifyChange();
        }

        return wasCollapsed && !isCollapsed;
    }

    /**
     * 按 sessionId 切换折叠（供 Command/外部调用）
     */
    toggleSession(sessionId: string, forceState?: boolean): boolean {
        const sessionEl = this.renderer.getSessionElement(sessionId) ?? this.renderer.getNode(sessionId);
        if (!sessionEl) return false;

        const collapsible = sessionEl.matches('.llm-ui-flow-window, .llm-ui-node') ? sessionEl
            : sessionEl.querySelector<HTMLElement>('.llm-ui-bubble--user, .llm-ui-node');
        if (!collapsible) return false;

        const current = collapsible.classList.contains('is-collapsed');
        const target = forceState !== undefined ? forceState : !current;
        if (target === current) return false;

        collapsible.classList.toggle('is-collapsed', target);
        if (!target) this.renderer.activateVisibleEditors(collapsible);
        const btn = collapsible.querySelector('[data-action="collapse"]') as HTMLElement;
        if (btn) this.updateChevron(btn, target);

        this.states[sessionId] = target;
        this.notifyChange();

        return current && !target; // 从折叠→展开
    }

    // ================================================================
    // 批量折叠
    // ================================================================

    setAllCollapsed(collapsed: boolean): void {
        const items = this.container.querySelectorAll<HTMLElement>('.llm-ui-bubble--user, .llm-ui-node, .llm-ui-flow-window');
        items.forEach((el) => {
            el.classList.toggle('is-collapsed', collapsed);
            const btn = el.querySelector('[data-action="collapse"]') as HTMLElement;
            if (btn) this.updateChevron(btn, collapsed);
            const id = el.dataset.historyId || el.dataset.id || el.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
            if (id) this.states[id] = collapsed;
        });

        this.container.querySelectorAll('[data-session-id]').forEach(el => {
            const id = (el as HTMLElement).dataset.sessionId;
            if (id) this.states[id] = collapsed;
        });

        if (!collapsed) this.renderer.activateVisibleEditors();

        this.notifyChange();
    }

    // ================================================================
    // 视口感知的 Unfold Chat 查找
    // ================================================================

    /**
     * 基于视口位置查找 unfold chat
     *
     * 统一逻辑，同时服务于：
     * - foldCurrentUnfolded():          direction='current'
     * - navigateUnfolded('prev'):       direction='prev'
     * - navigateUnfolded('next'):       direction='next'
     *
     * @param direction  查找方向
     * @param roleFilter 可选角色过滤（'assistant' | 'user'），null 表示不限
     * @returns sessionId | '__start__' | '__end__' | null
     */
    findUnfoldedByViewport(
        direction: 'current' | 'prev' | 'next',
        roleFilter: string | null = null
    ): string | null | '__end__' | '__start__' {
        const containerRect = this.container.getBoundingClientRect();
        const viewportTop = containerRect.top;
        const viewportBottom = containerRect.bottom;
        const TITLE_HEIGHT = CollapseController.TITLE_HEIGHT;

        // 收集所有未折叠的 session
        const unfoldedElements = this.collectUnfoldedElements(roleFilter);
        if (unfoldedElements.length === 0) return null;

        // 分类：在视口上方、视口中、视口下方
        const aboveViewport: HTMLElement[] = [];
        const inViewport: HTMLElement[] = [];
        const belowViewport: HTMLElement[] = [];

        for (const el of unfoldedElements) {
            const rect = el.getBoundingClientRect();
            const titleBottom = rect.top + TITLE_HEIGHT;

            if (titleBottom < viewportTop) {
                aboveViewport.push(el);
            } else if (rect.top > viewportBottom) {
                belowViewport.push(el);
            } else {
                inViewport.push(el);
            }
        }

        switch (direction) {
            case 'current':
                return this.findCurrent(
                    inViewport, aboveViewport, viewportTop
                );

            case 'prev':
                return this.findPrev(
                    unfoldedElements, aboveViewport, viewportTop, TITLE_HEIGHT
                );

            case 'next':
                return this.findNext(
                    unfoldedElements, aboveViewport, inViewport, belowViewport
                );
        }
    }

    /**
     * 折叠当前视口中可见的 unfold chat（最靠上的那个）
     */
    foldCurrentUnfolded(): void {
        const sessionId = this.findUnfoldedByViewport('current');
        if (sessionId && sessionId !== '__start__' && sessionId !== '__end__') {
            this.toggleSession(sessionId, true);
        }
    }

    // ================================================================
    // 智能折叠
    // ================================================================

    /**
     * 智能判断当前应该折叠还是展开
     *
     * 规则：只要有任何 assistant 会话处于展开状态，就优先折叠
     */
    shouldCollapse(): boolean {
        const assistantNodes = this.container.querySelectorAll(
            '.llm-ui-session--assistant .llm-ui-node, .llm-ui-flow-window[data-role="assistant"]'
        );

        for (const node of assistantNodes) {
            if (!node.classList.contains('is-collapsed') && !node.parentElement?.closest('.is-collapsed')) {
                return true;
            }
        }

        return false;
    }

    /**
     * 智能切换：根据当前状态自动决定折叠或展开
     *
     * @returns 操作后是否处于折叠状态
     */
    toggleAll(): boolean {
        const shouldCollapse = this.shouldCollapse();
        this.setAllCollapsed(shouldCollapse);
        return shouldCollapse;
    }

    // ================================================================
    // 代码块折叠
    // ================================================================

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

    // ================================================================
    // 内部 — 视口查找辅助
    // ================================================================

    /**
     * 收集所有未折叠的 session 元素
     */
    private collectUnfoldedElements(roleFilter: string | null): HTMLElement[] {
        const unfoldedElements: HTMLElement[] = [];
        const allSessions = this.container.querySelectorAll('.llm-ui-session, [data-history-id]');

        for (const el of allSessions) {
            const sessionEl = el as HTMLElement;
            if (sessionEl.classList.contains('llm-ui-session') && sessionEl.querySelector('.llm-ui-flow-window')) continue;
            const id = sessionEl.dataset.historyId || sessionEl.dataset.sessionId;
            if (!id) continue;
            if (this.states[id] || sessionEl.classList.contains('is-collapsed')) continue; // 已折叠，跳过

            if (roleFilter &&
                !sessionEl.classList.contains(`llm-ui-session--${roleFilter}`) && sessionEl.dataset.role !== roleFilter) {
                continue;
            }

            unfoldedElements.push(sessionEl);
        }

        return unfoldedElements;
    }

    /**
     * direction='current': 视口中最靠上的 unfold chat
     */
    private findCurrent(
        inViewport: HTMLElement[],
        aboveViewport: HTMLElement[],
        viewportTop: number
    ): string | null {
        // 视口中有 unfold chat → 返回最靠上的
        if (inViewport.length > 0) {
            return inViewport[0].dataset.historyId || inViewport[0].dataset.sessionId || null;
        }

        // 视口中没有，检查视口上方最后一个是否 body 仍然可见
        if (aboveViewport.length > 0) {
            const last = aboveViewport[aboveViewport.length - 1];
            const rect = last.getBoundingClientRect();
            if (rect.bottom > viewportTop) {
                return last.dataset.historyId || last.dataset.sessionId || null;
            }
        }

        return null;
    }

    /**
     * direction='prev': 上一个 unfold chat
     */
    private findPrev(
        allUnfolded: HTMLElement[],
        aboveViewport: HTMLElement[],
        viewportTop: number,
        titleHeight: number
    ): string | null | '__start__' {
        // 先检查 title 被滚出视口但 body 仍可见的
        const titleHidden = this.findTitleHiddenElement(
            allUnfolded, viewportTop, titleHeight
        );
        if (titleHidden) return titleHidden.dataset.historyId || titleHidden.dataset.sessionId || null;

        // 视口上方最后一个
        if (aboveViewport.length > 0) {
            return aboveViewport[aboveViewport.length - 1].dataset.historyId || aboveViewport[aboveViewport.length - 1].dataset.sessionId || null;
        }

        // 已在最顶部
        return this.container.scrollTop > 0 ? '__start__' : null;
    }

    /**
     * direction='next': 下一个 unfold chat
     */
    private findNext(
        allUnfolded: HTMLElement[],
        aboveViewport: HTMLElement[],
        inViewport: HTMLElement[],
        belowViewport: HTMLElement[]
    ): string | null | '__end__' {
        // 视口下方的第一个
        if (belowViewport.length > 0) {
            return belowViewport[0].dataset.historyId || belowViewport[0].dataset.sessionId || null;
        }

        // 所有 unfold chat 都在视口中或上方 → 到底了
        const lastInView = inViewport[inViewport.length - 1] ?? null;
        const lastOverall = allUnfolded[allUnfolded.length - 1];

        if (lastInView === lastOverall ||
            (aboveViewport.length + inViewport.length === allUnfolded.length)) {
            return '__end__';
        }

        return null;
    }

    /**
     * 查找 title 被滚出视口但 body 仍可见的元素
     */
    private findTitleHiddenElement(
        elements: HTMLElement[],
        viewportTop: number,
        titleHeight: number
    ): HTMLElement | null {
        for (const el of elements) {
            const rect = el.getBoundingClientRect();
            const titleBottom = rect.top + titleHeight;
            if (titleBottom < viewportTop && rect.bottom > viewportTop) {
                return el;
            }
        }
        return null;
    }

    // ================================================================
    // 内部
    // ================================================================

    private updateChevron(btn: HTMLElement, isCollapsed: boolean): void {
        btn.setAttribute('aria-expanded', String(!isCollapsed));
        const svg = btn.querySelector('svg');
        if (svg) {
            svg.innerHTML = isCollapsed
                ? LayoutTemplates.chevronDown()
                : LayoutTemplates.chevronUp();
        }
    }

    private notifyChange(): void {
        this.bus?.emit('state:collapseChanged', { states: { ...this.states } });
    }

    destroy(): void {
        this.states = {};
    }
}
