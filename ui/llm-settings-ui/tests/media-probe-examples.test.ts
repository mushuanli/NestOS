// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountMediaProbe } from '../src/editors/provider-media-probe';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import type { MediaProbeExamples } from '@itookit/kernel-adapters/contracts';

const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function mount(examples?: MediaProbeExamples) {
    const provider: LLMProvider = {id: 'provider', name: 'Provider', implementation: 'custom', baseURL: '',
        media: {'image.generate': {adapter: 'openai-images'}, 'speech.synthesize': {adapter: 'openai-speech'}},
        models: [{id: 'image', name: 'Image', operations: {'image.generate': {inputModalities: ['text'], outputModalities: ['image'], formats: ['png']}}},
            {id: 'speech', name: 'Speech', operations: {'speech.synthesize': {inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['voice']}}}]};
    const form = document.createElement('form'); form.innerHTML = '<div data-provider-panel="overview"></div>'; document.body.append(form);
    const run = vi.fn(async () => ({success: true, message: 'Verified'}));
    stops.push(mountMediaProbe(form, () => provider, run, examples));
    return {form, run, input: () => form.querySelector<HTMLTextAreaElement>('[data-probe-input]')!, select: form.querySelector<HTMLSelectElement>('[data-probe-model]')!, button: form.querySelector<HTMLButtonElement>('[data-probe-run]')!};
}

it('snapshots host examples, renders them as text and uses the selected operation without automatic requests', () => {
    const examples = {'image.generate': {input: '<img src=x onerror=alert(1)>'}, 'speech.synthesize': {input: 'Speech sample'}};
    const f = mount(examples); examples['speech.synthesize'].input = 'Changed by caller';
    expect(f.input().value).toBe(examples['image.generate'].input); expect(f.form.querySelector('img')).toBeNull();
    f.select.value = 'speech:speech.synthesize'; f.select.dispatchEvent(new Event('change', {bubbles: true}));
    expect(f.input().value).toBe('Speech sample'); expect(f.run).not.toHaveBeenCalled();
});

it('keeps an edited or cleared input during form refresh and submits the actual draft', async () => {
    const f = mount({'image.generate': {input: 'Default example'}});
    f.input().value = ''; f.form.dispatchEvent(new Event('input')); expect(f.input().value).toBe('');
    f.input().value = 'User draft'; f.form.dispatchEvent(new Event('input')); expect(f.input().value).toBe('User draft');
    f.button.click(); await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({request: expect.objectContaining({prompt: 'User draft'})}));
});

it('leaves an unconfigured example empty and rejects empty input before calling the service', async () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {}), f = mount();
    expect(f.input().value).toBe(''); f.button.click();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith('media.probe.failed', expect.objectContaining({stage: 'validation', code: 'MEDIA_TEST_INPUT'})));
    expect(f.run).not.toHaveBeenCalled();
});
