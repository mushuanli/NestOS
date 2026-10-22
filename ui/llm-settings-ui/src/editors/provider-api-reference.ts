import { escapeAttr, escapeHTML, t } from '@itookit/common';
import type { ProviderApiReference, ApiSupport } from '@itookit/kernel-adapters/contracts';

/** Documentation stays read-only and cannot enable unimplemented request fields. */
export function renderProviderApiReference(reference?: ProviderApiReference): string {
    if (!reference) return '';
    const entry = (name: string, id: string, support: ApiSupport, notes = '') =>
        `<li>${escapeHTML(name)} · <code>${escapeHTML(id)}</code> · ${t(`provider.reference.${support}`)} ${escapeHTML(notes)}</li>`;
    return `<details class="settings-form__group" data-provider-reference><summary>${t('provider.reference.title')}</summary>
        <p>${t('provider.reference.version', {version: reference.version, date: reference.reviewedAt})}</p>
        <p>${escapeHTML(reference.scope)}</p>
        <ul>${reference.sources.filter(source => /^https:\/\//.test(source.url)).map(source =>
            `<li><a href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.title)}</a></li>`).join('')}</ul>
        <h4>${t('provider.reference.models')}</h4><ul>${reference.models.map(model => entry(model.name, model.id, model.support, model.notes)).join('')}</ul>
        <h4>${t('provider.reference.formats')}</h4><ul>${reference.formats.map(format => entry(format.name, format.wireValue, format.support,
            `${format.sampleRates.join(', ')} Hz; ${t('provider.reference.default')}: ${format.defaultSampleRate} Hz; ${format.notes ?? ''}`)).join('')}</ul>
        <h4>${t('provider.reference.parameters')}</h4><ul>${reference.parameters.map(parameter => entry(parameter.name, parameter.path, parameter.support,
            `${parameter.type}; ${t(parameter.required ? 'provider.reference.required' : 'provider.reference.optional')}; ${parameter.default === undefined ? '' : `${t('provider.reference.default')}: ${parameter.default}; `}${parameter.min === undefined ? '' : `[${parameter.min}, ${parameter.max}]; `}${parameter.notes ?? ''}`)).join('')}</ul>
        <details><summary>${t('provider.reference.voices', {count: reference.voices.length})}</summary><ul>${reference.voices.map(voice =>
            `<li>${escapeHTML(voice.name)} · <code>${escapeHTML(voice.id)}</code> · ${escapeHTML(voice.languages.join(', '))} ${escapeHTML(voice.notes ?? '')}</li>`).join('')}</ul></details>
        <p>${escapeHTML(reference.discovery.models)}</p><p>${escapeHTML(reference.discovery.voices)}</p>
        <ul>${reference.notes.map(note => `<li>${escapeHTML(note)}</li>`).join('')}</ul></details>`;
}
