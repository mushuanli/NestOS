import {escapeHTML, t} from '@itookit/common';
import type {ImageProcessingPreference} from '@itookit/kernel-adapters/contracts';
import {isImageResizePolicy} from '@itookit/kernel-adapters/contracts';
import {SettingsValidationError} from '@itookit/ui-common';

export function renderAgentImageSettings(value?: ImageProcessingPreference): string {
    const mode = value?.resize?.mode ?? 'inherit';
    return `<div class="agent-form-row"><label class="agent-form-label">${t('image.settings')}</label>
        <select class="agent-form-input" name="imageResizeMode" aria-label="${t('image.settings')}">
            <option value="inherit" ${mode === 'inherit' ? 'selected' : ''}>${t('image.agentDefault')}</option>
            <option value="original" ${mode === 'original' ? 'selected' : ''}>${t('image.original')}</option>
            <option value="max-edge" ${mode === 'max-edge' ? 'selected' : ''}>${t('image.custom')}</option>
        </select>
        <input class="agent-form-input" name="imageMaxEdge" type="number" min="1" max="32768" step="1"
            aria-label="${t('image.maxEdge')}" value="${escapeHTML(String(value?.resize?.mode === 'max-edge' ? value.resize.maxEdge : 1024))}">
        <p class="agent-form-help">${t('image.hint')}</p></div>`;
}
export function readAgentImageSettings(container: HTMLElement): ImageProcessingPreference | undefined {
    const mode = container.querySelector<HTMLSelectElement>('[name=imageResizeMode]')?.value;
    if (!mode) return undefined;
    if (mode === 'inherit') return undefined;
    const resize = mode === 'original' ? {mode: 'original' as const}
        : {mode: 'max-edge' as const, maxEdge: Number(container.querySelector<HTMLInputElement>('[name=imageMaxEdge]')?.value)};
    if (!isImageResizePolicy(resize)) throw new SettingsValidationError(t('image.invalid'));
    return {resize};
}
