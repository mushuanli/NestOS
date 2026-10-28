// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ParameterSources} from '../../llm-ui-adapter/src/flows/parameter-sources';
afterEach(() => document.body.replaceChildren());
it('blocks failed reads and ignores a late file result after manual editing', async () => {
    const root = document.createElement('div'); root.innerHTML = '<div class="llm-parameter-field"><textarea data-parameter="0">original</textarea></div>';
    document.body.append(root);
    let resolve!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise(done => {resolve = done;}));
    const sources = new ParameterSources({execute} as any, {navigation: 'notes'}, [{name: 'text', type: 'string'}]);
    const dispose = sources.mount(root), field = root.querySelector('textarea')!, reference = root.querySelector<HTMLInputElement>('.flow-content-source > input')!;
    const read = root.querySelectorAll<HTMLButtonElement>('.flow-content-source > button')[0];
    reference.value = '@notes:/file.md'; read.click();
    expect(() => sources.validate()).toThrow();
    field.value = 'manual'; field.dispatchEvent(new Event('input'));
    resolve({text: 'stale'}); await vi.waitFor(() => expect(read.disabled).toBe(false));
    expect(field.value).toBe('manual'); expect(() => sources.validate()).not.toThrow();
    execute.mockImplementationOnce(async () => {throw new Error('File access denied');}); read.click();
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')!.textContent).toBe('File access denied'));
    expect(field.value).toBe('manual'); expect(() => sources.validate()).toThrow(); dispose();
});
