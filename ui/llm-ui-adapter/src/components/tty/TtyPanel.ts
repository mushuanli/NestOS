// @file: llm-ui/components/tty/TtyPanel.ts
//
// TtyPanel — inline terminal widget for a single TTY session.
//
// Rendered inside `.llm-ui-node__tty-panels` of an agent message node.
// Shows real-time stdout/stderr output. Process input must travel through the
// Kernel control plane instead of bypassing process lifecycle management.

import { escapeHTML, t } from '@itookit/common';

const MAX_OUTPUT_CHARS = 100_000; // prevent unbounded DOM growth

export class TtyPanel {
    readonly sessionId: string;

    private el: HTMLElement;
    private outputEl: HTMLPreElement;
    private statusEl: HTMLElement;
    private exitInfoEl: HTMLElement | null = null;
    private exited = false;

    constructor(
        container: HTMLElement,
        sessionId: string,
        command: string,
        pid: number | undefined,
    ) {
        this.sessionId = sessionId;
        this.el = this.render(command, pid);
        container.appendChild(this.el);

        this.outputEl  = this.el.querySelector('.llm-ui-tty-panel__output') as HTMLPreElement;
        this.statusEl  = this.el.querySelector('.llm-ui-tty-panel__status') as HTMLElement;
    }

    appendOutput(chunk: string): void {
        if (this.exited) return;
        // Guard against XSS — append as text node
        this.outputEl.appendChild(document.createTextNode(chunk));

        // Trim if output exceeds max to avoid memory pressure
        if (this.outputEl.textContent && this.outputEl.textContent.length > MAX_OUTPUT_CHARS) {
            const trimmed = this.outputEl.textContent.slice(-MAX_OUTPUT_CHARS);
            this.outputEl.textContent = trimmed;
        }

        // Auto-scroll to bottom
        this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }

    finalize(exitCode: number | null): void {
        if (this.exited) return;
        this.exited = true;

        this.statusEl.className = 'llm-ui-tty-panel__status llm-ui-tty-panel__status--exited';
        this.statusEl.textContent = t(exitCode === null ? 'tty.status.stopped' : 'tty.status.exited');

        // Append exit info bar
        this.exitInfoEl = document.createElement('div');
        this.exitInfoEl.className = 'llm-ui-tty-panel__exit-info';
        // `null` means no exit code was observed (the session was killed by a signal, or the
        // host never saw it exit). Reporting a code — even "?" — would misstate how it ended.
        this.exitInfoEl.textContent = exitCode === null
            ? t('tty.exit.unknown')
            : t('tty.exit.known', { code: exitCode });
        this.el.appendChild(this.exitInfoEl);
    }

    destroy(): void {
        this.el.remove();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private render(command: string, pid: number | undefined): HTMLElement {
        const el = document.createElement('div');
        el.className = 'llm-ui-tty-panel';
        el.dataset.sessionId = this.sessionId;

        const pidText = pid !== undefined ? `PID:${pid}` : '';
        el.innerHTML = `
            <div class="llm-ui-tty-panel__header">
                <span class="llm-ui-tty-panel__cmd">$ ${escapeHTML(command)}</span>
                ${pidText ? `<span class="llm-ui-tty-panel__pid">${escapeHTML(pidText)}</span>` : ''}
                <span class="llm-ui-tty-panel__status llm-ui-tty-panel__status--running">running</span>
            </div>
            <pre class="llm-ui-tty-panel__output"></pre>`;
        return el;
    }
}
