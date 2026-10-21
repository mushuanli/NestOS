import { escapeAttr, t } from '@itookit/common';
import { isReasoningCapabilities, type LLMModel } from '@itookit/driver-llm/contracts';
import { SettingsValidationError } from '@itookit/ui-common';

export function renderReasoningDeclaration(model: LLMModel, draft?: string, protocolsDraft?: string): string {
    return `<details class="provider-settings__reasoning"><summary>${t('provider.reasoning.title')}</summary>
        <small class="settings-form__help">${t('provider.reasoning.help')}</small>
        <label class="settings-form__label">${t('provider.reasoning.levels')}</label>
        <input class="settings-form__input" data-reasoning-levels value="${escapeAttr(model.reasoning ? model.reasoning.efforts.map(option => option.id + (option.value && option.value !== option.id ? '=' + option.value : '')).join(', ') : '')}" placeholder="low, high, max=xhigh">
        <label class="settings-form__label">${t('provider.reasoning.default')}</label>
        <input class="settings-form__input" data-reasoning-default value="${escapeAttr(model.reasoning && model.reasoning.defaultEffort || '')}">
        <label class="settings-form__label">${t('provider.reasoning.canDisable')}</label>
        <select class="settings-form__select" data-reasoning-disable><option value="">${t('connection.reasoningDefault')}</option><option value="true" ${model.reasoning && model.reasoning.canDisable === true ? 'selected' : ''}>${t('provider.reasoning.allowed')}</option><option value="false" ${model.reasoning && model.reasoning.canDisable === false ? 'selected' : ''}>${t('provider.reasoning.notAllowed')}</option></select>
        <details><summary>${t('provider.form.advanced')}</summary>
        <label class="settings-form__label">${t('provider.reasoning.declaration')}</label>
        <textarea class="settings-form__input" name="modelReasoning" rows="5">${escapeAttr(draft ?? JSON.stringify(model.reasoning ?? null, null, 2))}</textarea>
        <label class="settings-form__label">${t('provider.reasoning.protocols')}</label>
        <textarea class="settings-form__input" name="modelReasoningByProtocol" rows="4">${escapeAttr(protocolsDraft ?? JSON.stringify(model.reasoningByProtocol ?? {}, null, 2))}</textarea>
        </details></details>`;
}

export function readReasoningDeclaration(row: Element): Pick<LLMModel, 'reasoning' | 'reasoningByProtocol'> {
    const field = row.querySelector<HTMLTextAreaElement>('[name="modelReasoning"]');
    const protocols = row.querySelector<HTMLTextAreaElement>('[name="modelReasoningByProtocol"]');
    if (!field || !protocols) return {};
    try {
        const reasoning = JSON.parse(field.value || 'null') ?? undefined;
        const byProtocol = JSON.parse(protocols.value || '{}');
        if (!isReasoningCapabilities(reasoning) || !byProtocol || Array.isArray(byProtocol)
            || Object.entries(byProtocol).some(([key, caps]) => !['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate'].includes(key) || !isReasoningCapabilities(caps))) throw new Error();
        field.setCustomValidity(''); protocols.setCustomValidity('');
        return { reasoning, reasoningByProtocol: Object.keys(byProtocol).length ? byProtocol : undefined };
    } catch {
        field.setCustomValidity(t('provider.reasoning.invalid'));
        throw new SettingsValidationError(t('provider.reasoning.invalid'));
    }
}

export function bindReasoningFields(form: HTMLFormElement): void {
    form.addEventListener('input', event => {
        const input = event.target as HTMLInputElement, row = input.closest('.settings-model-item');
        if (!row) return;
        if (input.matches('[data-reasoning-levels], [data-reasoning-default], [data-reasoning-disable]')) updateReasoningFields(row);
        if (input.matches('[data-reasoning-levels], [data-reasoning-default], [data-reasoning-disable], [name="modelReasoning"], [name="modelReasoningByProtocol"]')) {
            try {
                const { reasoning } = readReasoningDeclaration(row);
                if (input.name === 'modelReasoning') {
                    row.querySelector<HTMLInputElement>('[data-reasoning-levels]')!.value = reasoning ? reasoning.efforts.map(option => option.id + (option.value && option.value !== option.id ? '=' + option.value : '')).join(', ') : '';
                    row.querySelector<HTMLInputElement>('[data-reasoning-default]')!.value = reasoning && reasoning.defaultEffort || '';
                    row.querySelector<HTMLSelectElement>('[data-reasoning-disable]')!.value = !reasoning || reasoning.canDisable === undefined ? '' : String(reasoning.canDisable);
                }
            } catch { /* Keep invalid declarations editable. */ }
        }
    });
}

function updateReasoningFields(row: Element): void {
    const field = row.querySelector<HTMLTextAreaElement>('[name="modelReasoning"]')!;
    try {
        const previous = JSON.parse(field.value || 'null') || {};
        const levels = row.querySelector<HTMLInputElement>('[data-reasoning-levels]')!.value.split(',').map(value => value.trim()).filter(Boolean);
        const efforts = levels.map(level => { const [id, value] = level.split('='); return { ...previous.efforts?.find((option: {id: string}) => option.id === id), id, ...(value ? { value } : {}) }; });
        const disable = row.querySelector<HTMLSelectElement>('[data-reasoning-disable]')!.value;
        field.value = JSON.stringify(efforts.length ? { ...previous, source: 'user', efforts, canDisable: disable ? disable === 'true' : undefined,
            defaultEffort: row.querySelector<HTMLInputElement>('[data-reasoning-default]')!.value.trim() || undefined } : null, null, 2);
    } catch { /* Raw drafts must be corrected before structured editing. */ }
}
