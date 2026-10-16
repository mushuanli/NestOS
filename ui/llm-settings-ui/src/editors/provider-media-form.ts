import { escapeAttr, t } from '@itookit/common';
import { SettingsValidationError } from '@itookit/ui-common';
import { isMediaCatalog, type LLMModel, type LLMProvider } from '@itookit/driver-llm/contracts';
export function renderMediaDeclaration(value: unknown, model = false, draft?: string): string {
    return `<div data-media-declaration><label class="settings-form__label">${t(model ? 'provider.media.operations' : 'provider.media.endpoints')}</label>
        <textarea class="settings-form__input" rows="5" name="${model ? 'modelOperations' : 'mediaEndpoints'}">${escapeAttr(draft ?? JSON.stringify(value ?? {}, null, 2))}</textarea>
        <small class="settings-form__help">${t('provider.media.help')}</small></div>`;
}
export function readMediaEndpoints(form: HTMLFormElement, previous: LLMProvider): LLMProvider['media'] {
    const field = form.querySelector<HTMLTextAreaElement>('[name="mediaEndpoints"]');
    return field && !field.disabled ? readDeclaration(field, false) as LLMProvider['media'] : previous.media;
}
export function readModelOperations(row: Element, previous: LLMModel): LLMModel['operations'] {
    const field = row.querySelector<HTMLTextAreaElement>('[name="modelOperations"]');
    return field && !field.disabled ? readDeclaration(field, true) as LLMModel['operations'] : previous.operations;
}
function readDeclaration(field: HTMLTextAreaElement, model: boolean): unknown {
    try {
        const value: unknown = JSON.parse(field.value || '{}');
        if (!isMediaCatalog(model ? undefined : value, model ? value : undefined)) throw new Error('Invalid declaration');
        field.setCustomValidity(''); return Object.keys(value as Record<string, unknown>).length ? value : undefined;
    } catch {
        const message = t('provider.media.invalid'); field.setCustomValidity(message); throw new SettingsValidationError(message);
    }
}
function validateDraft(field: HTMLTextAreaElement): void {
    if (field.disabled) return;
    try { readDeclaration(field, field.name === 'modelOperations'); } catch { /* Keep the invalid draft editable. */ }
}
export function syncMediaDeclarations(form: HTMLFormElement): void {
    const disabled = form.querySelector<HTMLSelectElement>('[name="implementation"]')?.value === 'chatgpt';
    form.querySelectorAll<HTMLElement>('[data-media-declaration]').forEach(group => {
        group.hidden = disabled;
        const field = group.querySelector<HTMLTextAreaElement>('textarea')!;
        field.disabled = disabled;
        validateDraft(field);
    });
}
/** Keep invalid JSON editable while blocking automatic persistence. */
export function bindMediaDeclarations(form: HTMLFormElement): void {
    form.addEventListener('input', event => {
        const field = event.target;
        if (!(field instanceof HTMLTextAreaElement) || !['modelOperations', 'mediaEndpoints'].includes(field.name)) return;
        validateDraft(field);
    });
}
