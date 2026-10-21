import { escapeAttr, t } from '@itookit/common';

type Declaration = Record<string, Record<string, unknown>>;
const operations = ['image.generate', 'speech.synthesize'] as const;
const fields = { model: ['formats', 'voices', 'sizes', 'qualities', 'features', 'maxInputCharacters', 'maxOutputs'], endpoint: ['path', 'sampleRate', 'responseFormat', 'assetHosts'] };

export function renderMediaFields(value: unknown, model: boolean): string {
    const data = (value ?? {}) as Declaration;
    return `<div class="provider-settings__fields" data-media-fields="${model ? 'model' : 'endpoint'}">${operations.map(operation => {
        const row = data[operation];
        return `<details data-media-operation="${operation}" ${row ? 'open' : ''}><summary><label><input type="checkbox" data-media-enable ${row ? 'checked' : ''}>${t(operation === 'image.generate' ? 'model.capability.imageGeneration' : 'model.capability.speechSynthesis')}</label></summary>
            ${model ? '' : adapterSelect(operation, row?.adapter)}
            ${(model ? fields.model : fields.endpoint).map(field => mediaField(field, row?.[field])).join('')}
            ${model && operation === 'speech.synthesize' ? mediaField('speedMin', (row?.speedRange as {min?: number})?.min) + mediaField('speedMax', (row?.speedRange as {max?: number})?.max) : ''}
        </details>`;
    }).join('')}</div>`;
}

function mediaField(field: string, value: unknown): string {
    const display = Array.isArray(value) ? value.join(', ') : value ?? '';
    return `<label class="settings-form__label">${t(`provider.field.${field}` as Parameters<typeof t>[0])}<input class="settings-form__input" data-media-field="${field}" value="${escapeAttr(String(display))}"></label>`;
}

function adapterSelect(operation: string, value: unknown): string {
    const adapters = operation === 'image.generate' ? ['openai-images', 'volcengine-images'] : ['openai-speech', 'doubao-speech'];
    if (typeof value === 'string' && !adapters.includes(value)) adapters.push(value);
    return `<label class="settings-form__label">${t('provider.field.adapter')}<select class="settings-form__select" data-media-field="adapter">${adapters.map(adapter => `<option ${value === adapter ? 'selected' : ''}>${escapeAttr(adapter)}</option>`).join('')}</select></label>`;
}

export function bindMediaFields(form: HTMLFormElement): void {
    form.addEventListener('input', event => {
        const input = event.target as HTMLInputElement, container = input.closest<HTMLElement>('[data-media-fields]');
        if (!container) return;
        const declaration = container.closest('[data-media-declaration]')!, raw = declaration.querySelector<HTMLTextAreaElement>('textarea')!;
        try {
            const value = JSON.parse(raw.value || '{}') as Declaration;
            for (const row of container.querySelectorAll<HTMLElement>('[data-media-operation]')) updateOperation(value, row, container.dataset.mediaFields === 'model');
            raw.value = JSON.stringify(value, null, 2); raw.dispatchEvent(new CustomEvent('input', { bubbles: true, detail: { structured: true } }));
        } catch { /* Do not overwrite an invalid raw draft. */ }
    });
}

function updateOperation(value: Declaration, row: HTMLElement, model: boolean): void {
    const operation = row.dataset.mediaOperation!;
    if (!row.querySelector<HTMLInputElement>('[data-media-enable]')!.checked) { delete value[operation]; return; }
    const next = { ...value[operation] };
    if (model) { next.inputModalities ??= ['text']; next.outputModalities ??= [operation === 'image.generate' ? 'image' : 'audio']; }
    for (const input of row.querySelectorAll<HTMLInputElement>('[data-media-field]')) {
        const key = input.dataset.mediaField!, text = input.value.trim();
        if (key === 'speedMin' || key === 'speedMax') continue;
        if (!text) { delete next[key]; continue; }
        next[key] = ['formats', 'voices', 'sizes', 'qualities', 'features', 'assetHosts'].includes(key) ? text.split(',').map(value => value.trim()).filter(Boolean)
            : ['sampleRate', 'maxInputCharacters', 'maxOutputs'].includes(key) ? Number(text) : text;
    }
    const min = row.querySelector<HTMLInputElement>('[data-media-field="speedMin"]')?.value;
    const max = row.querySelector<HTMLInputElement>('[data-media-field="speedMax"]')?.value;
    if (min || max) next.speedRange = { min: Number(min), max: Number(max) }; else delete next.speedRange;
    value[operation] = next;
}
