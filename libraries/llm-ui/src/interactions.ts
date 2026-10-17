import type { InputField, InteractionResponse, InteractionView } from './contracts';
import { button, element, errorText } from './dom';
import type { Translate } from './i18n';

export class InteractionCard {
    readonly element = element('section', 'llm-chat__interaction');
    private readonly form = element('form');
    private readonly feedback = element('p', 'llm-chat__error');
    private busy = false;
    private closed = false;
    constructor(readonly request: InteractionView, private readonly t: Translate,
        private readonly submit: (response: InteractionResponse) => Promise<void>) {
        this.element.dataset.requestId = request.id;
        this.element.append(element('h3', undefined, request.title), element('p', undefined, request.detail ?? ''), this.form, this.feedback);
        if (request.state !== 'pending') { this.form.textContent = request.state; return; }
        if (request.kind === 'approval') this.approval();
        else this.input(request.fields);
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
        for (const field of fields) this.form.append(fieldControl(field));
        const send = element('button', undefined, this.t('answer')); send.type = 'submit'; this.form.append(send);
        this.form.addEventListener('submit', event => {
            event.preventDefault();
            const data = new FormData(this.form), values: Record<string, string | string[]> = {};
            for (const field of fields) {
                const items = data.getAll(field.id).map(String);
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
        if (this.busy || this.closed) return;
        this.busy = true; this.disable(true); this.feedback.textContent = this.t('pending');
        try { await this.submit(response); if (!this.closed) this.feedback.textContent = this.t('accepted'); }
        catch (error) { if (!this.closed) this.feedback.textContent = errorText(error); }
        finally { this.busy = false; if (!this.closed) this.disable(false); }
    }
    setPending(pending: boolean, message?: string): void {
        this.disable(pending || this.busy);
        if (message) this.feedback.textContent = message;
    }
    private disable(value: boolean): void {
        this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea')
            .forEach(control => { control.disabled = value; });
    }
    destroy(): void { this.closed = true; this.element.remove(); }
}

function fieldControl(field: InputField): HTMLElement {
    const group = element('fieldset'); group.append(element('legend', undefined, field.label));
    if (field.kind === 'text') {
        const input = element(field.multiline ? 'textarea' : 'input');
        input.name = field.id; input.required = field.required ?? false; group.append(input); return group;
    }
    for (const choice of field.choices) {
        const label = element('label'), input = element('input');
        input.type = field.kind === 'single-choice' ? 'radio' : 'checkbox'; input.name = field.id; input.value = choice.id;
        label.append(input, document.createTextNode(choice.label)); group.append(label);
    }
    return group;
}
