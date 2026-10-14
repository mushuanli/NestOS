import { escapeAttr, t } from '@itookit/common';
import { API_PROTOCOLS, getPrimaryProtocol, getProviderProtocols, getProviderDefaultProtocol } from '@itookit/driver-llm/contracts';
import type { ApiProtocol, LLMProvider } from '@itookit/driver-llm/contracts';

export const PROTOCOL_LABELS: Record<ApiProtocol, string> = {
    'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses',
    'anthropic-messages': 'Anthropic Messages', 'gemini-generate': 'Gemini Generate',
};
const PATH_FIELDS: Record<ApiProtocol, string> = {
    'openai-chat': 'chatPath', 'openai-responses': 'responsesPath',
    'anthropic-messages': 'anthropicPath', 'gemini-generate': 'geminiPath',
};
const DEFAULT_PATHS: Record<ApiProtocol, string> = {
    'openai-chat': '/v1/chat/completions', 'openai-responses': '/responses',
    'anthropic-messages': '/v1/messages', 'gemini-generate': '/v1beta/models',
};

export function renderProtocolOptions(provider: LLMProvider, selected = ''): string {
    const supported = getProviderProtocols(provider);
    const automatic = `<option value="">${t('provider.protocol.automatic', { protocol: PROTOCOL_LABELS[getProviderDefaultProtocol(provider)] })}</option>`;
    const legacy = selected && !supported.includes(selected as ApiProtocol)
        ? `<option value="${escapeAttr(selected)}" selected disabled>${escapeAttr(selected)} — ${t('provider.protocol.unavailable')}</option>` : '';
    return automatic + legacy + supported.map(protocol =>
        `<option value="${protocol}" ${selected === protocol ? 'selected' : ''}>${PROTOCOL_LABELS[protocol]}</option>`).join('');
}

function renderProtocolRow(provider: LLMProvider, protocol: ApiProtocol): string {
    const field = PATH_FIELDS[protocol];
    const enabled = getProviderProtocols(provider).includes(protocol);
    const value = provider[field as keyof LLMProvider]
        ?? (protocol === getPrimaryProtocol(provider) ? provider.defaultPath : '') ?? '';
    return `<div data-protocol="${protocol}" ${enabled ? '' : 'hidden'}>
        <label><input type="checkbox" name="supportedProtocols" value="${protocol}" ${enabled ? 'checked' : ''}>${PROTOCOL_LABELS[protocol]}</label>
        <input class="settings-form__input" name="${field}" value="${escapeAttr(String(value))}" placeholder="${DEFAULT_PATHS[protocol]}">
        <button type="button" class="settings-btn settings-btn--xs" data-test-protocol="${protocol}">${t('provider.protocol.test')}</button>
        <small data-protocol-result="${protocol}">${t('provider.protocol.unverified')}</small>
    </div>`;
}

export function renderProviderAdvanced(provider: LLMProvider): string {
    const protocols = getProviderProtocols(provider);
    return `<details class="settings-form__group"><summary>${t('provider.form.advanced')}</summary>
        <label class="settings-form__label">${t('provider.protocol.default')}</label>
        <select class="settings-form__select" name="defaultProtocol">${protocols.map(protocol =>
            `<option value="${protocol}" ${getProviderDefaultProtocol(provider) === protocol ? 'selected' : ''}>${PROTOCOL_LABELS[protocol]}</option>`).join('')}</select>
        <label class="settings-form__label">${t('provider.protocol.available')}</label>
        <div id="provider-protocols">${API_PROTOCOLS.map(protocol => renderProtocolRow(provider, protocol)).join('')}</div>
        <select class="settings-form__select" id="provider-add-protocol"><option value="">${t('provider.protocol.add')}</option>${API_PROTOCOLS.map(protocol =>
            `<option value="${protocol}" ${protocols.includes(protocol) ? 'hidden' : ''}>${PROTOCOL_LABELS[protocol]}</option>`).join('')}</select>
        <label class="settings-form__label">${t('provider.models.endpoint')}</label>
        <input class="settings-form__input" name="modelsPath" value="${escapeAttr(provider.modelsPath ?? '')}" placeholder="${t('provider.models.endpointDefault')}">
        <label class="settings-form__label">${t('provider.form.temperature')}</label>
        <input type="number" class="settings-form__input" name="defaultTemperature" value="${provider.defaultTemperature ?? ''}" min="0" max="2" step="0.1">
    </details>`;
}

export function readProviderForm(form: HTMLFormElement, previous: LLMProvider): LLMProvider {
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const supportedProtocols = [...form.querySelectorAll<HTMLInputElement>('[name="supportedProtocols"]:checked')]
        .map(input => input.value as ApiProtocol);
    const implementation = (data.implementation || previous.implementation) as LLMProvider['implementation'];
    const paths = Object.fromEntries(Object.values(PATH_FIELDS).map(field => [field, data[field]?.trim() || undefined]));
    const primary = getPrimaryProtocol({ implementation });
    return { ...previous, ...paths, implementation, baseURL: data.baseURL.trim(),
        apiKey: data.apiKey.trim() || previous.apiKey, supportedProtocols,
        defaultProtocol: form.querySelector<HTMLSelectElement>('[name="defaultProtocol"]')?.value as ApiProtocol,
        defaultPath: paths[PATH_FIELDS[primary]], modelsPath: data.modelsPath?.trim() || undefined };
}

export function syncProtocolControls(form: HTMLFormElement): void {
    const checked = [...form.querySelectorAll<HTMLInputElement>('[name="supportedProtocols"]:checked')].map(input => input.value as ApiProtocol);
    const select = form.querySelector<HTMLSelectElement>('[name="defaultProtocol"]')!;
    const previous = select.value;
    select.innerHTML = checked.map(protocol => `<option value="${protocol}">${PROTOCOL_LABELS[protocol]}</option>`).join('');
    if (checked.includes(previous as ApiProtocol)) select.value = previous;
    form.querySelectorAll<HTMLElement>('[data-protocol]').forEach(row => {
        row.hidden = !checked.includes(row.dataset.protocol as ApiProtocol);
    });
    form.querySelectorAll<HTMLOptionElement>('#provider-add-protocol option').forEach(option => {
        option.hidden = checked.includes(option.value as ApiProtocol);
    });
}
