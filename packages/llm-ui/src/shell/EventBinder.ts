// @file: llm-ui/shell/EventBinder.ts

import { installResponsiveActions } from '@itookit/ui-common';
import { EventCleanup } from '../components/common/EventCleanup';

export interface EventBinderCallbacks {
    onToggleSidebar: () => void;
    onToggleHistory: () => void;
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

    constructor(
        private container: HTMLElement,
        private callbacks: Partial<EventBinderCallbacks>
    ) { }

    private bindToolbarMenu(): void {
        const menu = this.container.querySelector<HTMLDetailsElement>('.llm-workspace-titlebar__menu');
        if (!menu) return;
        const titlebar = menu.closest<HTMLElement>('.llm-workspace-titlebar');
        const toolbar = titlebar?.querySelector<HTMLElement>('.llm-workspace-titlebar__primary');
        if (titlebar && toolbar) {
            const actions = ['llm-btn-refresh', 'llm-btn-session-rerun', 'llm-btn-history-visibility', 'llm-btn-navigator', 'llm-btn-copy']
                .flatMap(id => { const button = menu.querySelector<HTMLElement>('#' + id); return button ? [button] : []; });
            this.disposeResponsive?.();
            this.disposeResponsive = installResponsiveActions({ container: titlebar, toolbar, actions, minWidth: 760,
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

    bindTitleBarEvents(): void {
        this.bindToolbarMenu();
        const sidebarBtn = this.container.querySelector('#llm-btn-sidebar');
        if (sidebarBtn) {
            this.events.add(sidebarBtn, 'click', () => {
                this.callbacks.onToggleSidebar?.();
            });
        }

        const titleInput = this.container.querySelector('#llm-title-input') as HTMLInputElement;
        if (titleInput) {
            this.events.add(titleInput, 'blur', () => {
                this.callbacks.onTitleChange?.(titleInput.value);
            });
            this.events.add(titleInput, 'keydown', ((e: KeyboardEvent) => {
                if (e.key === 'Enter') titleInput.blur();
            }) as EventListener);
        }

        const assetsBtn = this.container.querySelector('#llm-btn-assets');
        if (assetsBtn) {
            this.events.add(assetsBtn, 'click', () => {
                this.callbacks.onOpenAssetManager?.();
            });
        }

        const historyBtn = this.container.querySelector('#llm-btn-history-visibility');
        if (historyBtn) {
            this.events.add(historyBtn, 'click', () => {
                this.callbacks.onToggleHistory?.();
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
            const el = this.container.querySelector(selector);
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
        this.disposeResponsive?.(); this.disposeResponsive = undefined;
        this.events.cleanup();
    }
}
