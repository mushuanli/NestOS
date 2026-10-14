import { escapeHTML, FEEDBACK_ICONS, t } from '@itookit/common';
import type { ChatInputInteraction, InteractionReply } from '../../domain/ports/IChatInputPresenter';

type Pending = { request: ChatInputInteraction; respond: (reply: InteractionReply) => Promise<void> };

/** An inline, persistent interaction surface, independent of the chat draft/loading state. */
export class InteractionPanel {
    private element?: HTMLElement;
    private pending?: Pending;
    private submitting = false;

    constructor(private readonly container: HTMLElement) {}

    show(request: ChatInputInteraction, respond: Pending['respond'], focus = true): void {
        if (this.pending?.request.key === request.key) return;
        this.clear();
        this.pending = { request, respond };
        const element = document.createElement('section');
        element.className = 'llm-input__interaction';
        element.setAttribute('role', 'region');
        element.setAttribute('aria-label', title(request));
        element.innerHTML = markup(request);
        element.querySelector('.llm-input__interaction-prompt')!.textContent = request.prompt;
        element.querySelector('.llm-input__interaction-details')!.textContent = request.details ?? '';
        element.querySelector<HTMLElement>('.llm-input__interaction-details')!.hidden = !request.details;
        element.addEventListener('click', event => this.handleClick(event));
        this.element = element;
        this.renderOptions(request.options ?? []);
        const wrapper = this.container.querySelector('.llm-input__field-wrapper');
        (wrapper?.parentElement ?? this.container).insertBefore(element, wrapper ?? null);
        if (focus) element.querySelector('textarea')!.focus({ preventScroll: true });
    }

    clear(interactionId?: string): void {
        if (interactionId && this.pending?.request.id !== interactionId) return;
        this.pending = undefined;
        this.submitting = false;
        this.element?.remove();
        this.element = undefined;
    }

    private renderOptions(options: string[]): void {
        const parent = this.element!.querySelector('.llm-input__interaction-options')!;
        for (const option of options) {
            const button = document.createElement('button');
            button.type = 'button'; button.dataset.interactionChoice = option;
            button.className = 'llm-input__interaction-choice';
            button.textContent = option;
            parent.append(button);
        }
    }

    private handleClick(event: MouseEvent): void {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!button || !this.element?.contains(button) || this.submitting) return;
        if (button.dataset.interactionChoice !== undefined) {
            this.element.querySelector('textarea')!.value = button.dataset.interactionChoice;
            this.element.querySelector('textarea')!.focus();
        } else if (button.dataset.interactionAction) {
            void this.submit(button.dataset.interactionAction === 'approve');
        }
    }

    private async submit(approved: boolean): Promise<void> {
        const pending = this.pending, element = this.element;
        if (!pending || !element || this.submitting) return;
        const text = element.querySelector('textarea')!.value.trim();
        const error = element.querySelector<HTMLElement>('.llm-input__interaction-error')!;
        if (pending.request.kind === 'input' && !text) { error.textContent = t('chatInput.interaction.required'); return; }
        error.textContent = '';
        this.setSubmitting(true);
        const reply = pending.request.kind === 'input' ? text : { approved, ...(text ? { note: text } : {}) };
        try {
            await pending.respond(reply);
            if (this.pending === pending) this.clear();
        } catch (failure) {
            if (this.pending !== pending) return;
            error.textContent = `${t('chatInput.interaction.failed')} ${failure instanceof Error ? failure.message : String(failure)}`;
        } finally {
            if (this.pending === pending) this.setSubmitting(false);
        }
    }

    private setSubmitting(value: boolean): void {
        this.submitting = value;
        this.element?.setAttribute('aria-busy', String(value));
        this.element?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea')
            .forEach(control => { control.disabled = value; });
        this.element!.querySelector('.llm-input__interaction-status')!.textContent = value ? t('chatInput.interaction.submitting') : '';
    }
}

function title(request: ChatInputInteraction): string {
    return t(request.kind === 'approval' ? 'chatInput.interaction.approvalTitle' : 'chatInput.interaction.inputTitle');
}

function markup(request: ChatInputInteraction): string {
    const approval = request.kind === 'approval';
    const label = t(approval ? 'chatInput.interaction.note' : 'chatInput.interaction.answer');
    const placeholder = t(approval ? 'chatInput.interaction.notePlaceholder' : 'chatInput.interaction.answerPlaceholder');
    return `<div class="llm-input__interaction-header"><span aria-hidden="true">${FEEDBACK_ICONS.auth}</span>
        <strong>${escapeHTML(title(request))}</strong></div>
        <p class="llm-input__interaction-hint">${escapeHTML(t(approval ? 'chatInput.interaction.approvalHint' : 'chatInput.interaction.inputHint'))}</p>
        <p class="llm-input__interaction-prompt"></p>
        <pre class="llm-input__interaction-details"></pre>
        <div class="llm-input__interaction-options"></div>
        <label class="llm-input__interaction-label">${escapeHTML(label)}
            <textarea class="llm-input__interaction-input" rows="2" placeholder="${escapeHTML(placeholder)}"></textarea></label>
        <p class="llm-input__interaction-error" role="alert"></p>
        <div class="llm-input__interaction-actions">
            <span class="llm-input__interaction-status" role="status"></span>
            ${approval ? `<button type="button" class="llm-input__interaction-reject" data-interaction-action="reject">${escapeHTML(t('chatInput.interaction.reject'))}</button>` : ''}
            <button type="button" class="llm-input__interaction-submit" data-interaction-action="${approval ? 'approve' : 'reply'}">${escapeHTML(t(approval ? 'chatInput.interaction.approve' : 'chatInput.interaction.submit'))}</button>
        </div>`;
}
