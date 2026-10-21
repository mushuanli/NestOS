// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLogger } from '@itookit/common';
import { promptFlowParameters } from '../../llm-ui-adapter/src/components/FlowParameterForm';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
});
afterEach(() => {document.querySelectorAll('dialog').forEach(dialog => dialog.close()); document.body.replaceChildren(); vi.restoreAllMocks();});

function choose(files: File[]) {
    const picker = document.querySelector<HTMLInputElement>('[data-image-picker]')!;
    Object.defineProperty(picker, 'files', {value: files, configurable: true}); picker.dispatchEvent(new Event('change'));
}
const files = () => Array.from({length: 5}, (_, index) => new File(['picture'], `private-page-${index}.png`, {type: 'image/png'}));
const submit = () => document.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));

it('accepts five supported images below the declared limits', async () => {
    const result = promptFlowParameters([{name: 'images', type: 'json', widget: 'images', required: true,
        imageConstraints: {maxItems: 12, maxBytes: 80 * 1024 * 1024, mimeTypes: ['image/png']}}]);
    choose(files()); submit();
    expect((await result)!.images).toHaveLength(5);
});

it.each([
    [{maxItems: 4}, 'IMAGE_COUNT', '5 张'],
    [{maxBytes: 20}, 'IMAGE_BYTES', '上限'],
    [{mimeTypes: ['image/jpeg']}, 'IMAGE_FORMAT', 'image/png'],
])('distinguishes a field constraint failure: %j', async (limits, code, message) => {
    const result = promptFlowParameters([{name: 'images', type: 'json', widget: 'images', imageConstraints: limits}]);
    choose(files()); submit();
    await vi.waitFor(() => expect(document.querySelector('[data-form-error]')?.textContent).toContain(message));
    const entry = getLogger().query({modules: ['flow-images']}).findLast(entry => (entry.data as {code?: string})?.code === code)!;
    expect(entry.data).toMatchObject({stage: 'validation', count: 5, bytes: 35, operationId: expect.any(String)});
    expect(JSON.stringify(entry)).not.toContain('private-page');
    document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); await result;
});

it('keeps an upload error distinct from format errors and allows selecting replacement files', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const assets = {import: vi.fn().mockRejectedValue(Object.assign(new Error('Upload storage is unavailable'), {code: 'INPUT_ASSET_PERSISTENCE', requestId})),
        read: vi.fn(async () => 'data:image/png;base64,cGljdHVyZQ==')};
    const result = promptFlowParameters([{name: 'images', type: 'json', widget: 'images', required: true}], undefined, undefined, undefined, undefined, assets);
    choose(files()); submit();
    await vi.waitFor(() => expect(document.querySelector('[data-form-error]')?.textContent).toContain('Upload storage is unavailable'));
    expect(document.querySelector('[data-image-preview]')?.textContent).toContain('private-page-0.png');
    const entry = getLogger().query({modules: ['flow-images']}).findLast(entry => (entry.data as {code?: string})?.code === 'INPUT_ASSET_PERSISTENCE')!;
    expect(entry.data).toMatchObject({stage: 'upload', count: 5, requestId});
    expect(JSON.stringify(entry)).not.toMatch(/private-page|base64|Upload storage/);
    assets.import.mockResolvedValue({kind: 'input', id: '11111111-1111-4111-8111-111111111111', bytes: 7, mimeType: 'image/png', sha256: 'a'.repeat(64)});
    choose(files()); submit(); expect((await result)!.images).toHaveLength(5);
});
