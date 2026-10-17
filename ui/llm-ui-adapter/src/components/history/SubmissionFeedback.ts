import { t } from '@itookit/common';
import type { ChatSubmission } from '../../domain/submission';
import { SessionRenderer, type RendererContext } from './SessionRenderer';

/** A transient user bubble, replaced only by its explicitly correlated history entry. */
export class SubmissionFeedback {
    private readonly renderer: SessionRenderer;
    private readonly observed = new Set<string>();
    private current?: ChatSubmission;
    constructor(container: HTMLElement, context: RendererContext) {
        this.renderer = new SessionRenderer(container, {...context, readOnly: true});
    }
    show(submission?: ChatSubmission): void {
        if (this.current?.id !== submission?.id) this.renderer.clear();
        this.current = submission;
        if (!submission || submission.messageId && this.observed.has(submission.messageId)) {
            this.renderer.clear(); return;
        }
        const id = 'submission-' + submission.id;
        if (!this.renderer.getSessionElement(id)) this.renderer.appendSession({id, role: 'user',
            content: submission.text, timestamp: submission.timestamp}, false);
        const row = this.renderer.getSessionElement(id);
        row?.querySelector('.llm-ui-actions')?.remove();
        const bubble = row?.querySelector('.llm-ui-bubble');
        if (!bubble) return;
        let status = bubble.querySelector<HTMLElement>('.llm-ui-submission-status');
        if (!status) { status = document.createElement('p'); status.className = 'llm-ui-submission-status'; status.setAttribute('role', 'status'); bubble.append(status); }
        status.dataset.state = submission.state;
        status.textContent = [t(`chat.submission.${submission.state}`), submission.error].filter(Boolean).join(' ');
    }
    observe(messageId: string): void {
        this.observed.add(messageId);
        if (this.observed.size > 1000) this.observed.delete(this.observed.values().next().value!);
        if (this.current?.messageId === messageId) this.renderer.clear();
    }
    clear(): void { this.current = undefined; this.observed.clear(); this.renderer.clear(); }
    destroy(): Promise<void> { this.observed.clear(); return this.renderer.destroy(); }
}
