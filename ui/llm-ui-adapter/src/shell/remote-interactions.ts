import type { ConversationRequest } from '@itookit/ui-common';
import { t } from '@itookit/common';
export function conversationRequests(requests: ConversationRequest[], respond: (id: string | number, response: Record<string, unknown>) => Promise<void>): HTMLElement[] {
    return requests.map(request => {
        const card = document.createElement('section');
        const heading = document.createElement('h3'); heading.textContent = t('harness.interaction');
        const detail = document.createElement('pre'); detail.textContent = request.detail;
        card.append(heading, detail);
        if (request.kind === 'approval') {
            action(card, t('harness.approve'), () => respond(request.id, {decision: 'accept'}));
            action(card, t('harness.decline'), () => respond(request.id, {decision: 'decline'}));
        } else if (request.kind === 'input') input(card, request, respond);
        else { const hint = document.createElement('p'); hint.textContent = t('harness.unsupportedInteraction'); card.append(hint); }
        return card;
    });
}
function input(card: HTMLElement, request: ConversationRequest, respond: (id: string | number, response: Record<string, unknown>) => Promise<void>) {
    const fields = new Map<string, HTMLInputElement>();
    for (const question of request.questions ?? []) {
        const label = document.createElement('label'); label.textContent = question.question;
        const field = document.createElement('input'); field.setAttribute('aria-label', question.question);
        field.placeholder = question.options?.map(o => o.label).join(' / ') ?? '';
        label.append(field); card.append(label); fields.set(question.id, field);
    }
    action(card, t('harness.answer'), () => respond(request.id, {answers: Object.fromEntries([...fields].map(([id, field]) => [id, {answers: [field.value]}]))}));
}
function action(card: HTMLElement, label: string, run: () => Promise<void>) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.onclick = async () => {
        button.disabled = true;
        try { await run(); } catch { const status = document.createElement('p'); status.textContent = t('harness.failed'); status.setAttribute('role', 'alert'); card.append(status); }
        finally { if (button.isConnected) button.disabled = false; }
    };
    card.append(button);
}
