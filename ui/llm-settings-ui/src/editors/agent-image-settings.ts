import {escapeHTML, t} from '@itookit/common';
import type {ImageProcessingPreference} from '@itookit/kernel-adapters/contracts';
import {isImageResizePolicy} from '@itookit/kernel-adapters/contracts';
import {SettingsValidationError} from '@itookit/ui-common';

export function renderAgentImageSettings(value?: ImageProcessingPreference): string {
    const mode = value?.resize?.mode ?? 'inherit';
    return `<div class="agent-form-row agent-image-settings"><div class="agent-form-grid">
        <label class="agent-form-field"><span class="agent-form-label">${t('agent.inputImage.title')}</span>
        <select class="agent-form-input" name="imageResizeMode" aria-label="${t('agent.inputImage.title')}">
            <option value="inherit" ${mode === 'inherit' ? 'selected' : ''}>${t('image.agentDefault')}</option>
            <option value="original" ${mode === 'original' ? 'selected' : ''}>${t('image.original')}</option>
            <option value="max-edge" ${mode === 'max-edge' ? 'selected' : ''}>${t('image.custom')}</option>
        </select></label>
        <label class="agent-form-field"><span class="agent-form-label">${t('image.maxEdge')}</span>
        <input class="agent-form-input" name="imageMaxEdge" type="number" min="1" max="32768" step="1"
            ${mode === 'max-edge' ? '' : 'disabled'}
            aria-label="${t('image.maxEdge')}" value="${escapeHTML(String(value?.resize?.mode === 'max-edge' ? value.resize.maxEdge : 1024))}"></label></div>
        <p class="agent-form-help">${t('agent.inputImage.hint')}</p></div>`;
}

export function bindAgentImageSettings(container: HTMLElement): void {
    const mode = container.querySelector<HTMLSelectElement>('[name="imageResizeMode"]');
    const edge = container.querySelector<HTMLInputElement>('[name="imageMaxEdge"]');
    mode?.addEventListener('change', () => { if (edge) edge.disabled = mode.value !== 'max-edge'; });
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
