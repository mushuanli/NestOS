// @file: llm-ui/shell/EventBinder.ts

import { installResponsiveActions, type EditorOptions } from '@itookit/ui-common';
import {EventCleanup} from '@itookit/llm-ui';

export interface EventBinderCallbacks {
    mountCompactNavigation: NonNullable<EditorOptions['mountCompactNavigation']>;
    mountConversationNavigation: NonNullable<EditorOptions['mountConversationNavigation']>;
    mountMoreMenu: NonNullable<EditorOptions['mountMoreMenu']>;
    onToggleSidebar: () => void;
    onTitleChange: (title: string) => void;
    onOpenAssetManager: () => void;
    onToggleNavigator: () => void;
    onPrevUnfolded: () => void;
    onNextUnfolded: () => void;
    onFoldCurrent: () => void;
    onCollapseAll: () => void;
    onCopy: () => void;
    onPrint: () => void;
    onRefresh: () => void;
}

export interface GlobalShortcutCallbacks {
    onToggleNavigator: () => void;
    onNavigatePrev: () => void;
    onNavigateNext: () => void;
    onCreateBranch: () => void;
    onSwitchBranchPrev?: () => void;
    onSwitchBranchNext?: () => void;
}

export class EventBinder {
    private events = new EventCleanup();
    private disposeResponsive?: () => void;
    private disposeConversationNavigation?: () => void;
    private disposeHostMenu?: () => void;
    private disposeHostNavigation?: () => void;
    private disposeBranchNavigation?: () => void;

    constructor(
        private container: HTMLElement,
        private callbacks: Partial<EventBinderCallbacks>
    ) { }

    private bindToolbarMenu(): void {
        const menu = this.container.querySelector<HTMLDetailsElement>('.llm-workspace-titlebar__menu');
        if (!menu) return;
        const content = menu.querySelector<HTMLElement>('.llm-workspace-titlebar__menu-actions');
        this.disposeHostMenu?.();
        if (content) this.disposeHostMenu = this.callbacks.mountMoreMenu?.(content.querySelector('.llm-workspace-titlebar__host-actions') ?? content);
        const titlebar = menu.closest<HTMLElement>('.llm-workspace-titlebar');
        const toolbar = titlebar?.querySelector<HTMLElement>('.llm-workspace-titlebar__primary');
        this.disposeConversationNavigation?.();
        if (toolbar) this.disposeConversationNavigation = this.callbacks.mountConversationNavigation?.(toolbar);
        if (titlebar && content) this.bindBranchNavigation(titlebar, content, menu.querySelector('summary')!);
        if (titlebar && toolbar) {
            const actions = ['llm-btn-prompt-nav', 'llm-btn-collapse', 'llm-btn-refresh', 'llm-btn-session-rerun', 'llm-btn-copy']
                .flatMap(id => { const button = menu.querySelectorAll<HTMLElement>('#' + id)[0]; return button ? [button] : []; });
            this.disposeResponsive?.();
            this.disposeResponsive = installResponsiveActions({ container: titlebar, toolbar, actions, minWidth: 769,
                fallbackFocus: menu.querySelector('summary')! });
        }
        this.events.add(document, 'click', event => {
            const target = event.target as Element;
            if (!menu.contains(target) || target.closest('button')) menu.open = false;
        });
        this.events.add(menu, 'keydown', event => {
            if ((event as KeyboardEvent).key !== 'Escape') return;
            menu.open = false; menu.querySelector('summary')?.focus();
        });
    }

    private bindBranchNavigation(titlebar: HTMLElement, menu: HTMLElement, fallbackFocus: HTMLElement): void {
        this.disposeBranchNavigation?.();
        const branch = titlebar.querySelector<HTMLElement>('#llm-branch-indicator');
        const title = titlebar.querySelector<HTMLElement>('.llm-workspace-titlebar__left');
        if (!branch || !title) return;
        const marker = document.createComment('branch-navigation'); branch.before(marker); menu.append(branch);
        const stop = installResponsiveActions({container: titlebar, toolbar: title, actions: [branch], minWidth: 769, fallbackFocus});
        this.disposeBranchNavigation = () => {stop(); marker.after(branch); marker.remove();};
    }

    bindTitleBarEvents(): void {
        const slot = this.container.querySelector<HTMLElement>('.llm-workspace-titlebar__compact-navigation');
        if (slot && this.callbacks.mountCompactNavigation) {
            this.disposeHostNavigation?.();
            this.disposeHostNavigation = this.callbacks.mountCompactNavigation(slot);
            slot.hidden = false; this.container.dataset.editorMobileNavigation = 'embedded';
        }
        this.bindToolbarMenu();
        const sidebarBtn = this.container.querySelectorAll('#llm-btn-sidebar')[0];
        if (sidebarBtn) {
            this.events.add(sidebarBtn, 'click', () => {
                this.callbacks.onToggleSidebar?.();
            });
        }

        const titleInput = this.container.querySelectorAll('#llm-title-input')[0] as HTMLInputElement;
        if (titleInput) {
            this.events.add(titleInput, 'blur', () => {
                this.callbacks.onTitleChange?.(titleInput.value);
            });
            this.events.add(titleInput, 'keydown', ((e: KeyboardEvent) => {
                if (e.key === 'Enter') titleInput.blur();
            }) as EventListener);
        }

        const assetsBtn = this.container.querySelectorAll('#llm-btn-assets')[0];
        if (assetsBtn) {
            this.events.add(assetsBtn, 'click', () => {
                this.callbacks.onOpenAssetManager?.();
            });
        }


    }

    bindNavigationEvents(): void {
        const bindings: Record<string, (() => void) | undefined> = {
            '#llm-btn-refresh': this.callbacks.onRefresh,
            '#llm-btn-navigator': this.callbacks.onToggleNavigator,
            '#llm-btn-prev-unfolded': this.callbacks.onPrevUnfolded,
            '#llm-btn-next-unfolded': this.callbacks.onNextUnfolded,
            '#llm-btn-fold-current': this.callbacks.onFoldCurrent,
            '#llm-btn-collapse': this.callbacks.onCollapseAll,
            '#llm-btn-copy': this.callbacks.onCopy,
            '#llm-btn-print': this.callbacks.onPrint,
        };

        for (const [selector, handler] of Object.entries(bindings)) {
            const el = this.container.querySelectorAll(selector)[0];
            if (el && handler) {
                this.events.add(el, 'click', handler);
            }
        }
    }

    bindGlobalShortcuts(shortcuts: GlobalShortcutCallbacks): void {
        const keydownHandler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

            const isMod = e.metaKey || e.ctrlKey;
            if (!isMod) return;

            // Cmd/Ctrl + Shift + B: 创建分支
            if (e.shiftKey && e.key === 'B') {
                e.preventDefault();
                shortcuts.onCreateBranch();
                return;
            }

            // Cmd/Ctrl + Shift + [ / ] : 切换分支
            if (e.shiftKey && e.key === '[' && shortcuts.onSwitchBranchPrev) {
                e.preventDefault();
                shortcuts.onSwitchBranchPrev();
                return;
            }
            if (e.shiftKey && e.key === ']' && shortcuts.onSwitchBranchNext) {
                e.preventDefault();
                shortcuts.onSwitchBranchNext();
                return;
            }

            const keyMap: Record<string, (() => void) | undefined> = {
                'k': shortcuts.onToggleNavigator,
                'ArrowUp': shortcuts.onNavigatePrev,
                'ArrowDown': shortcuts.onNavigateNext,
            };

            const handler = keyMap[e.key];
            if (handler) {
                e.preventDefault();
                handler();
            }
        };

        this.events.add(document, 'keydown', keydownHandler as EventListener);
    }

    cleanup(): void {
        this.disposeBranchNavigation?.(); this.disposeBranchNavigation = undefined;
        this.disposeHostNavigation?.(); this.disposeHostNavigation = undefined;
        delete this.container.dataset.editorMobileNavigation;
        this.disposeHostMenu?.(); this.disposeHostMenu = undefined;
        this.disposeConversationNavigation?.(); this.disposeConversationNavigation = undefined;
        this.disposeResponsive?.(); this.disposeResponsive = undefined;
        this.events.cleanup();
    }
}
