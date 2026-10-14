import { t } from '@itookit/common';
import type { HarnessEvent } from '@itookit/app-contracts/services';

type NativeRequest = HarnessEvent['message'];
export function renderInteraction(request: NativeRequest, respond: (response: Record<string, unknown>) => Promise<void>): HTMLElement {
    const section = document.createElement('section'); section.className = 'harness-control__interaction';
    const heading = document.createElement('h3'); heading.textContent = t('harness.interaction');
    const detail = document.createElement('pre'); detail.textContent = JSON.stringify(request.params, null, 2);
    section.append(heading, detail);
    if (request.method === 'item/tool/requestUserInput') userInput(section,request,respond);
    else if (['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method)) {
        action(section,t('harness.approve'),() => respond({ decision: 'accept' }));
        action(section,t('harness.decline'),() => respond({ decision: 'decline' }));
    } else { const hint = document.createElement('p'); hint.textContent = t('harness.unsupportedInteraction'); section.append(hint); }
    return section;
}

function userInput(section: HTMLElement, request: NativeRequest, respond: (response: Record<string, unknown>) => Promise<void>) {
    const questions = request.params?.questions as Array<{ id: string; question: string; options?: Array<{ label: string }> }> | undefined;
    if (!Array.isArray(questions)) return;
    const fields = new Map<string, HTMLInputElement>();
    for (const question of questions) {
        const label = document.createElement('label'); label.textContent = question.question;
        const input = document.createElement('input'); input.setAttribute('aria-label',question.question);
        input.placeholder = question.options?.map(o => o.label).join(' / ') ?? '';
        fields.set(question.id,input); label.append(input); section.append(label);
    }
    action(section,t('harness.answer'),async () => {
        const answers = Object.fromEntries([...fields].map(([id,input]) => [id,{ answers: [input.value] }]));
        await respond({ answers });
    });
}

function action(parent: HTMLElement, label: string, run: () => Promise<void>) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.onclick = async () => {
        button.disabled = true;
        try { await run(); } catch { const error = document.createElement('p'); error.textContent = t('harness.failed'); error.setAttribute('role','alert'); parent.append(error); }
        finally { button.disabled = false; }
    };
    parent.append(button);
}
