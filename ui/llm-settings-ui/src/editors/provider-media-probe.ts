import { randomUUID, escapeAttr, t } from '@itookit/common';
import { requireMediaCapabilities, type LLMProvider, type MediaGenerationInput, type MediaOperation, type ProviderConnectionTestParams, type ConnectionTestResult } from '@itookit/driver-llm/contracts';
import {providerTestResult} from './provider-test-result';
import type { MediaProbeExamples, ProviderApiReference } from '@itookit/kernel-adapters/contracts';

type RunProbe = (request: ProviderConnectionTestParams) => Promise<ConnectionTestResult>;
export function mountMediaProbe(form: HTMLFormElement, draft: () => LLMProvider, run: RunProbe, examples: MediaProbeExamples = {}, reference?: ProviderApiReference): () => void {
    const defaults = structuredClone(examples);
    const panel = document.createElement('section'); panel.className = 'provider-settings__probe';
    panel.innerHTML = `<h4>${t('provider.media.verify')}</h4><select class="settings-form__select" data-probe-model></select>
        <div data-probe-fields></div><button type="button" class="settings-btn settings-btn--secondary" data-probe-run>${t('provider.media.run')}</button>
        <p role="status" data-probe-result></p><div data-probe-preview></div>`;
    form.querySelector('[data-provider-panel="overview"]')?.append(panel);
    let disposed = false, busy = false, urls: string[] = [];
    const clear = () => { urls.forEach(url => URL.revokeObjectURL(url)); urls = []; panel.querySelector('[data-probe-preview]')!.replaceChildren(); };
    const refresh = () => { if (!disposed && !busy) { try { populateProbe(panel, draft(), defaults, reference); } catch { /* Keep the last valid probe while editing a draft. */ } } };
    panel.querySelector<HTMLButtonElement>('[data-probe-run]')!.onclick = async () => {
        if (busy) return; busy = true; clear();
        const started = performance.now(), operationId = randomUUID();
        const button = panel.querySelector<HTMLButtonElement>('[data-probe-run]')!, result = panel.querySelector<HTMLElement>('[data-probe-result]')!;
        button.disabled = true; result.textContent = t('provider.protocol.testing');
        try {
            const provider = draft(), snapshot = JSON.stringify(provider), request = probeRequest(panel, provider);
            const response = await run({ provider: provider.id, providerDefinition: provider, apiKey: provider.apiKey,
                baseURL: provider.baseURL, model: request.model, operation: request.operation, request });
            if (disposed) return;
            if (snapshot !== JSON.stringify(draft()) || JSON.stringify(request) !== JSON.stringify(probeRequest(panel, draft()))) { result.textContent = t('provider.test.stale'); return; }
            result.textContent = providerTestResult(response);
            panel.dataset.probeState = response.success ? 'success' : 'error';
            if (response.success) urls = showPreview(panel, response);
        } catch (error) {
            const failure = error as { code?: string };
            console.error('media.probe.failed', { operation: 'media.verify', operationId, stage: failure?.code === 'MEDIA_TEST_INPUT' ? 'validation' : 'request',
                code: failure?.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'MEDIA_PROBE_FAILED', durationMs: Math.round(performance.now() - started) });
            if (!disposed) { result.textContent = error instanceof Error ? error.message : String(error); panel.dataset.probeState = 'error'; }
        }
        finally { busy = false; if (!disposed) { button.disabled = false; refresh(); } }
    };
    const change = (event: Event) => {
        const target = event.target as HTMLElement, internal = panel.contains(target);
        if (internal && !target.matches('[data-probe-model], [data-probe-input], [data-probe-format], [data-probe-voice], [data-probe-size]')) return;
        clear(); panel.querySelector('[data-probe-result]')!.textContent = t('provider.test.stale'); delete panel.dataset.probeState;
        if (!internal) refresh();
    };
    form.addEventListener('change', change); form.addEventListener('input', change); refresh();
    return () => { disposed = true; clear(); form.removeEventListener('change', change); form.removeEventListener('input', change); };
}

function populateProbe(panel: HTMLElement, provider: LLMProvider, examples: MediaProbeExamples, reference?: ProviderApiReference): void {
    const select = panel.querySelector<HTMLSelectElement>('[data-probe-model]')!, previous = select.value;
    select.innerHTML = provider.models.flatMap(model => (['image.generate', 'speech.synthesize'] as const).flatMap(operation => {
        try { requireMediaCapabilities(provider, model, operation); return [`<option value="${escapeAttr(encodeURIComponent(model.id))}:${operation}">${escapeAttr(model.name)} · ${t(operation === 'image.generate' ? 'model.capability.imageGeneration' : 'model.capability.speechSynthesis')}</option>`]; } catch { return []; }
    })).join('');
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    const saved = Object.fromEntries([...panel.querySelectorAll<HTMLInputElement>('[data-probe-input], [data-probe-format], [data-probe-voice], [data-probe-size]')].map(field => [field.getAttributeNames().find(name => name.startsWith('data-probe-'))!, field.value]));
    const render = () => renderProbeFields(panel, provider, examples, reference);
    select.onchange = render; render();
    if (select.value === previous) for (const [key, value] of Object.entries(saved)) {
        const field = panel.querySelector<HTMLInputElement | HTMLSelectElement>(`[${key}]`);
        if (field && (!(field instanceof HTMLSelectElement) || [...field.options].some(option => option.value === value))) field.value = value;
    }
    panel.querySelector<HTMLButtonElement>('[data-probe-run]')!.disabled = !select.value;
}

function renderProbeFields(panel: HTMLElement, provider: LLMProvider, examples: MediaProbeExamples, reference?: ProviderApiReference): void {
    const [identity, operation] = panel.querySelector<HTMLSelectElement>('[data-probe-model]')!.value.split(':');
    const model = provider.models.find(item => item.id === decodeURIComponent(identity)), caps = model?.operations?.[operation as MediaOperation];
    const root = panel.querySelector<HTMLElement>('[data-probe-fields]')!;
    if (!caps) { root.textContent = t('provider.media.noOperation'); return; }
    root.innerHTML = `<label class="settings-form__label">${t('provider.media.input')}</label><textarea class="settings-form__input" data-probe-input rows="2"></textarea>
        ${probeSelect('format', caps.formats)}${operation === 'speech.synthesize' ? probeSelect('voice', caps.voices ?? [], reference?.voices) : caps.sizes?.length ? probeSelect('size', caps.sizes) : ''}`;
    root.querySelector<HTMLTextAreaElement>('[data-probe-input]')!.value = examples[operation as MediaOperation]?.input ?? '';
}

function probeSelect(field: 'format' | 'voice' | 'size', values: string[], labels: ReadonlyArray<{id: string; name: string}> = []): string {
    return `<label class="settings-form__label">${t(`provider.media.${field}`)}</label><select class="settings-form__select" data-probe-${field}>${values.map(value => {
        const name = labels.find(label => label.id === value)?.name;
        return `<option value="${escapeAttr(value)}">${escapeAttr(name ? `${name} · ${value}` : value)}</option>`;
    }).join('')}</select>`;
}

function probeRequest(panel: HTMLElement, provider: LLMProvider): MediaGenerationInput {
    const [identity, operation] = panel.querySelector<HTMLSelectElement>('[data-probe-model]')!.value.split(':');
    const value = (name: string) => panel.querySelector<HTMLInputElement>(`[data-probe-${name}]`)?.value;
    const model = provider.models.find(item => item.id === decodeURIComponent(identity))?.id, format = value('format')!;
    if (!model || !value('input')?.trim()) throw Object.assign(new Error(t('provider.media.inputRequired')), { code: 'MEDIA_TEST_INPUT' });
    return operation === 'speech.synthesize'
        ? { operation, model, input: value('input')!, voice: value('voice')!, format: format as 'mp3' }
        : { operation: 'image.generate', model, prompt: value('input')!, format: format as 'png', ...(value('size') ? { size: value('size') } : {}) };
}

function showPreview(panel: HTMLElement, response: ConnectionTestResult): string[] {
    const urls: string[] = [], root = panel.querySelector('[data-probe-preview]')!;
    for (const asset of response.assets ?? []) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav'].includes(asset.mimeType)) continue;
        const url = URL.createObjectURL(new Blob([new Uint8Array(asset.data).buffer], { type: asset.mimeType })); urls.push(url);
        const element = asset.mimeType.startsWith('image/') ? document.createElement('img') : document.createElement('audio');
        if (element instanceof HTMLImageElement) element.alt = t('provider.media.preview'); else element.controls = true;
        element.src = url; root.append(element);
    }
    return urls;
}
