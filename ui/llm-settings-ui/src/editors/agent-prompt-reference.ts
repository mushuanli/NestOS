import { escapeHTML, generateUUID, t } from '@itookit/common';
import { type SystemPromptDefinition } from '@itookit/tools/contracts';
import { type IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { Toast, type EditorHostContext } from '@itookit/ui-common';

/** The shared text is a preview; only its identity is stored in the Agent. */
export function renderPromptReference(prompts: SystemPromptDefinition[], selected?: string): string {
    const missing = selected && !prompts.some(prompt => prompt.id === selected);
    return `<div class="agent-form-row"><label class="agent-form-label" for="system-prompt-preset">${t('prompt.reference')}</label>
        <select id="system-prompt-preset" name="systemPromptId">
            <option value="">${t('prompt.none')}</option>
            ${missing ? `<option value="${escapeHTML(selected)}" selected>${escapeHTML(t('prompt.missing', { id: selected }))}</option>` : ''}
            ${prompts.map(prompt => `<option value="${escapeHTML(prompt.id)}" ${prompt.id === selected ? 'selected' : ''}>${escapeHTML(prompt.name)}</option>`).join('')}
        </select>
        <p class="agent-form-help">${t('prompt.referenceHint')}</p>
        <div data-prompt-actions>
            <button type="button" class="settings-btn settings-btn--secondary settings-btn--sm" data-prompt-edit>${t('prompt.editShared')}</button>
            <button type="button" class="settings-btn settings-btn--secondary settings-btn--sm" data-prompt-copy>${t('prompt.copy')}</button>
        </div>
        <textarea class="agent-form-textarea" data-prompt-preview readonly aria-label="${t('prompt.reference')}"></textarea>
    </div>`;
}

export function bindPromptReference(container: HTMLElement, prompts: SystemPromptDefinition[], service: IAgentManagementService,
    host: EditorHostContext | undefined, changed: () => void): void {
    const select = container.querySelector<HTMLSelectElement>('[name="systemPromptId"]');
    if (!select) return;
    const preview = container.querySelector<HTMLTextAreaElement>('[data-prompt-preview]')!;
    const edit = container.querySelector<HTMLButtonElement>('[data-prompt-edit]')!;
    const copy = container.querySelector<HTMLButtonElement>('[data-prompt-copy]')!;
    const refresh = () => {
        const prompt = prompts.find(item => item.id === select.value);
        preview.hidden = !select.value;
        preview.value = prompt?.content.join('\n\n') ?? (select.value ? t('prompt.missing', { id: select.value }) : '');
        edit.disabled = !prompt || !host?.navigate; copy.disabled = !prompt;
    };
    select.addEventListener('change', refresh);
    edit.addEventListener('click', () => {
        void Promise.resolve(host?.navigate?.({ target: 'toolbox', resourceId: '/prompts/' + encodeURIComponent(select.value) }))
            .catch(error => Toast.error(String(error)));
    });
    copy.addEventListener('click', () => {
        copy.disabled = true;
        void savePromptCopy(select, prompts, service, changed).catch(error => Toast.error(String(error))).finally(refresh);
    });
    refresh();
}

async function savePromptCopy(select: HTMLSelectElement, prompts: SystemPromptDefinition[], service: IAgentManagementService,
    changed: () => void): Promise<void> {
    const sourceId = select.value;
    const original = await service.getSystemPrompt(sourceId);
    if (!original) throw new Error(t('prompt.missing', { id: sourceId }));
    const prompt = { ...structuredClone(original), id: generateUUID(), name: t('prompt.copyName', { name: original.name }) };
    await service.saveSystemPrompt(prompt); prompts.push(prompt);
    select.add(new Option(prompt.name, prompt.id));
    if (select.value === sourceId) { select.value = prompt.id; changed(); }
}
