import type { InputField, InteractionResponse, InteractionView } from './contracts';
import { button, element, errorText } from './dom';
import type { Translate } from './i18n';
import {translator} from './i18n';
import {interactionField} from './interaction-fields';

export function createInteractionCard(request: InteractionView, submit: (response: InteractionResponse) => Promise<void>,
    options: {locale?: string; translate?: (key: string) => string} = {}): InteractionCard {
    return new InteractionCard(request, translator(options.locale, options.translate), submit);
}

export class InteractionCard {
    readonly element = element('section', 'llm-chat__interaction');
    private readonly form = element('form');
    private readonly feedback = element('p', 'llm-chat__error');
    private busy = false;
    private pending = false;
    private closed = false;
    constructor(readonly request: InteractionView, private readonly t: Translate,
        private readonly submit: (response: InteractionResponse) => Promise<void>) {
        this.element.dataset.requestId = request.id;
        this.element.append(element('h3', undefined, request.title), element('p', undefined, request.detail ?? ''), this.form, this.feedback);
        if (request.state !== 'pending') { this.form.textContent = request.state; return; }
        if (request.kind === 'approval') this.approval();
        else if (request.kind === 'input') this.input(request.fields);
        else this.form.textContent = this.t('unsupportedInteraction');
    }
    private approval(): void {
        const request = this.request;
        if (request.kind !== 'approval') return;
        const note = element('textarea'); note.setAttribute('aria-label', this.t('note'));
        if (request.note) this.form.append(note);
        for (const decision of request.decisions) this.form.append(button(decision.label, () => {
            void this.run({ kind: 'approval', decisionId: decision.id, ...(request.note ? { note: note.value } : {}) });
        }));
    }
    private input(fields: readonly InputField[]): void {
        const controls = fields.map(field => ({field, control: interactionField(field)}));
        controls.forEach(({control}) => this.form.append(control.element));
        const send = element('button', undefined, this.t('answer')); send.type = 'submit'; this.form.append(send);
        this.form.addEventListener('submit', event => {
            event.preventDefault();
            const values: Record<string, string | string[]> = Object.create(null);
            for (const {field, control} of controls) {
                const items = control.values();
                if (field.required && !items.some(value => value.trim())) { this.feedback.textContent = this.t('required'); return; }
                if (field.kind === 'multi-choice' && (items.length < (field.min ?? 0) || items.length > (field.max ?? Infinity))) {
                    this.feedback.textContent = this.t('range'); return;
                }
                values[field.id] = field.kind === 'multi-choice' ? items : items[0] ?? '';
            }
            void this.run({ kind: 'input', values });
        });
    }
    private async run(response: InteractionResponse): Promise<void> {
        if (this.busy || this.pending || this.closed) return;
        this.busy = true; this.disable(true); this.feedback.textContent = this.t('pending');
        try { await this.submit(response); if (!this.closed) this.feedback.textContent = this.t('accepted'); }
        catch (error) { if (!this.closed) this.feedback.textContent = errorText(error); }
        finally { this.busy = false; if (!this.closed) this.disable(this.pending); }
    }
    setPending(pending: boolean, message?: string): void {
        this.pending = pending || !!this.request.responding;
        this.disable(this.pending || this.busy);
        if (message) this.feedback.textContent = message;
    }
    private disable(value: boolean): void {
        this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea')
            .forEach(control => { control.disabled = value; });
    }
    destroy(): void { this.closed = true; this.element.remove(); }
}
