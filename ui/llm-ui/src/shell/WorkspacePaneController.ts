export type HistoryVisibility = 'visible' | 'hidden';

/**
 * Owns workspace pane visibility only. It deliberately does not know about
 * conversation history policies or context assembly.
 */
export class WorkspacePaneController {
    private visibility: HistoryVisibility = 'visible';

    constructor(
        private readonly workspace: HTMLElement,
        private readonly historyPane: HTMLElement,
        private readonly historyToggle: HTMLButtonElement,
        private readonly onHistoryVisibilityChanged: (visibility: HistoryVisibility) => void,
    ) {}

    getHistoryVisibility(): HistoryVisibility {
        return this.visibility;
    }

    setHistoryVisibility(
        visibility: HistoryVisibility,
        options: { persist?: boolean } = {},
    ): void {
        if (visibility === 'hidden' && this.historyPane.contains(document.activeElement)) {
            this.historyToggle.focus();
        }

        this.visibility = visibility;
        const visible = visibility === 'visible';
        this.workspace.classList.toggle('llm-ui-workspace--history-hidden', !visible);
        this.historyPane.hidden = !visible;
        this.historyPane.setAttribute('aria-hidden', String(!visible));
        this.historyToggle.setAttribute('aria-pressed', String(visible));
        this.historyToggle.setAttribute('aria-label', visible ? 'Hide history' : 'Show history');
        this.historyToggle.setAttribute('title', visible ? 'Hide history' : 'Show history');

        if (visible) this.clearUnread();
        if (options.persist !== false) this.onHistoryVisibilityChanged(visibility);
    }

    toggleHistory(): void {
        this.setHistoryVisibility(this.visibility === 'visible' ? 'hidden' : 'visible');
    }

    markUnread(kind: 'update' | 'error' = 'update'): void {
        if (this.visibility === 'visible') return;
        const badge = this.historyToggle.querySelector<HTMLElement>('.llm-workspace-titlebar__badge');
        if (!badge) return;
        badge.hidden = false;
        badge.dataset.kind = kind;
    }

    clearUnread(): void {
        const badge = this.historyToggle.querySelector<HTMLElement>('.llm-workspace-titlebar__badge');
        if (!badge) return;
        badge.hidden = true;
        delete badge.dataset.kind;
    }
}
