// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {InputAssetCommand} from '@itookit/app-contracts';
import {sha256Hex} from '@itookit/llm-context/digest';
import type {FlowParameter} from '@itookit/llm-flow/contracts';
import {flowInputAssets} from '../../llm-ui-adapter/src/flows/input-assets';
import {validateComposerFiles} from '../../llm-ui-adapter/src/flows/composer-file-bindings';
import {promptFlowParameters} from '../../llm-ui-adapter/src/components/FlowParameterForm';
import {agentFlowInput} from '../../llm-ui-adapter/src/flows/agent-flow-input';
import {openFlowSettings} from '../../llm-ui-adapter/src/components/dag/FlowSettingsDialog';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
});
afterEach(() => {document.querySelectorAll('dialog').forEach(dialog => dialog.close()); document.body.replaceChildren(); vi.restoreAllMocks();});

function setup() {
    const stored = new Map<string, unknown>();
    const execute = vi.fn(async (command: string, args?: any): Promise<any> => {
        if (command === InputAssetCommand.Inspect) return stored.has(args.uploadId) ? {state: 'ready', reference: stored.get(args.uploadId)} : {state: 'missing'};
        if (command === InputAssetCommand.ImportFile) {
            const reference = {kind: 'input', id: args.uploadId, mimeType: args.mimeType, bytes: args.bytes, sha256: args.sha256};
            stored.set(args.uploadId, reference); return reference;
        }
        throw new Error('Unexpected test command');
    });
    return {execute, stored, assets: flowInputAssets({execute} as never)};
}
const parameter: FlowParameter = {name: 'documents', type: 'json', widget: 'files', required: true,
    fileConstraints: {minItems: 1, maxItems: 2, maxBytes: 50, mimeTypes: ['text/plain', 'application/pdf']}};
const submit = (dialog: HTMLElement) => dialog.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
function choose(dialog: HTMLElement, files: File[]): void {
    const picker = dialog.querySelector<HTMLInputElement>('[data-file-picker]')!;
    Object.defineProperty(picker, 'files', {value: files, configurable: true}); picker.dispatchEvent(new Event('change', {bubbles: true}));
}

it('submits ordered generic files and an empty file as structured arguments with no message text', async () => {
    const f = setup(), files = [new File(['%PDF selected'], 'spec.pdf', {type: 'application/pdf'}), new File([], 'empty.txt', {type: 'text/plain'})];
    const result = promptFlowParameters([parameter], undefined, undefined, undefined, undefined, f.assets,
        undefined, {initialFiles: {documents: files}}), dialog = document.querySelector('dialog')!;
    submit(dialog); const values = await result;
    expect(values?.documents).toEqual(files.map((file, i) => ({type: 'file', name: file.name, source: {type: 'asset', asset: {
        kind: 'input', id: [...f.stored.keys()][i], mimeType: file.type, bytes: file.size, sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }}})));
    expect(f.execute.mock.calls.filter(([command]) => command === InputAssetCommand.ImportFile)).toHaveLength(2);
    expect(JSON.stringify(values)).not.toContain('%PDF');
});

it('keeps a failed upload editable and retries using its original upload ID', async () => {
    const f = setup(), original = f.execute.getMockImplementation()!, uploads: string[] = [];
    f.execute.mockImplementation(async (command, args) => {
        if (command === InputAssetCommand.ImportFile) {uploads.push(args.uploadId); if (uploads.length === 1) throw Object.assign(new Error('Storage full'), {code: 'ENOSPC'});}
        return original(command, args);
    });
    const result = promptFlowParameters([parameter], undefined, undefined, undefined, undefined, f.assets), dialog = document.querySelector('dialog')!;
    choose(dialog, [new File(['selected'], 'notes.txt', {type: 'text/plain'})]); submit(dialog);
    await vi.waitFor(() => expect(dialog.querySelector('[data-form-error]')!.textContent).toContain('ENOSPC'));
    expect(dialog.isConnected).toBe(true); expect(dialog.querySelector('[data-file-picker]')!.getAttribute('aria-invalid')).toBe('true');
    dialog.querySelector<HTMLButtonElement>('[data-retry-files]')!.click(); submit(dialog);
    expect((await result)?.documents).toHaveLength(1); expect(uploads).toHaveLength(2); expect(uploads[1]).toBe(uploads[0]);
});

it('reconciles lost upload replies and rechecks readiness without uploading again', async () => {
    const f = setup(), original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, args) => {
        const receipt = await original(command, args);
        if (command === InputAssetCommand.ImportFile) throw new Error('Reply lost after commit');
        return receipt;
    });
    const file = new File(['selected'], 'notes.txt', {type: 'text/plain'});
    const first = await f.assets.importFile(file); expect(await f.assets.importFile(file)).toEqual(first);
    expect(f.execute.mock.calls.filter(([command]) => command === InputAssetCommand.ImportFile)).toHaveLength(1);
    expect(f.execute.mock.calls.filter(([command]) => command === InputAssetCommand.Inspect)).toHaveLength(3);
});

it('does not upload after a failed inspection and rejects a conflicting server receipt', async () => {
    const f = setup(), original = f.execute.getMockImplementation()!, file = new File(['selected'], 'notes.txt', {type: 'text/plain'});
    f.execute.mockRejectedValueOnce(Object.assign(new Error('Read transport down'), {code: 'OFFLINE'}));
    await expect(f.assets.importFile(file)).rejects.toMatchObject({code: 'OFFLINE'});
    expect(f.execute.mock.calls.some(([command]) => command === InputAssetCommand.ImportFile)).toBe(false);
    f.execute.mockImplementation(async (command, args) => command === InputAssetCommand.ImportFile
        ? {...await original(command, args), bytes: 999} : original(command, args));
    // The server committed the correct identity; reconciliation verifies that fact.
    expect(await f.assets.importFile(file)).toMatchObject({bytes: file.size});
    f.execute.mockImplementation(async () => ({state: 'ready', reference: {kind: 'input', id: 'foreign'}}));
    await expect(f.assets.importFile(file)).rejects.toMatchObject({code: 'INPUT_ASSET_RECEIPT_INVALID'});
});

it('cancels only one observer of a shared upload', async () => {
    const f = setup(), original = f.execute.getMockImplementation()!; let release!: () => void;
    f.execute.mockImplementation(async (command, args) => {
        if (command === InputAssetCommand.ImportFile) await new Promise<void>(resolve => {release = resolve;});
        return original(command, args);
    });
    const file = new File(['selected'], 'notes.txt', {type: 'text/plain'}), controller = new AbortController();
    const first = f.assets.importFile(file, controller.signal), stopped = expect(first).rejects.toMatchObject({name: 'AbortError'});
    const second = f.assets.importFile(file); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort(); await stopped; release(); expect(await second).toMatchObject({bytes: file.size});
    expect(f.execute.mock.calls.filter(([command]) => command === InputAssetCommand.ImportFile)).toHaveLength(1);
});

it('refuses changed bytes under the same browser File and upload identity', async () => {
    const f = setup(), file = new File(['first'], 'notes.txt', {type: 'text/plain'});
    Object.defineProperty(file, 'arrayBuffer', {value: vi.fn().mockResolvedValueOnce(new TextEncoder().encode('first').buffer)
        .mockResolvedValueOnce(new TextEncoder().encode('other').buffer)});
    await f.assets.importFile(file);
    await expect(f.assets.importFile(file)).rejects.toMatchObject({code: 'INPUT_ASSET_CONTENT_MISMATCH'});
    expect(f.execute.mock.calls.filter(([command]) => command === InputAssetCommand.ImportFile)).toHaveLength(1);
});

it('never advances an old multi-file selection using a replacement selection cancellation signal', async () => {
    let release!: (value: any) => void;
    const ref = {kind: 'input', id: '12345678-1234-4123-8123-123456789abc', mimeType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64)};
    const importFile = vi.fn(async (file: File) => file.name === 'old.txt' ? new Promise(resolve => {release = resolve;}) : ref);
    const f = setup(), result = promptFlowParameters([parameter], undefined, undefined, undefined, undefined, {...f.assets, importFile} as never);
    const dialog = document.querySelector('dialog')!;
    choose(dialog, ['old.txt', 'should-not-start.txt'].map(name => new File(['x'], name, {type: 'text/plain'})));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    choose(dialog, [new File(['x'], 'replacement.txt', {type: 'text/plain'})]); release(ref); submit(dialog);
    expect((await result)?.documents).toEqual([{type: 'file', name: 'replacement.txt', source: {type: 'asset', asset: ref}}]);
    expect(importFile.mock.calls.map(([file]) => file.name)).toEqual(['old.txt', 'replacement.txt']);
});

it('validates file count, MIME and total bytes before uploading and keeps explicit clear separate from defaults', async () => {
    const defaultFile = {type: 'file', name: 'default.txt', source: {type: 'asset', asset: {kind: 'input',
        id: '12345678-1234-4123-8123-123456789abc', mimeType: 'text/plain', bytes: 1, sha256: 'a'.repeat(64)}}};
    const f = setup(), result = promptFlowParameters([{...parameter, required: false, default: [defaultFile], fileConstraints: {maxItems: 1, maxBytes: 2, mimeTypes: ['text/plain']}}],
        undefined, undefined, undefined, undefined, f.assets), dialog = document.querySelector('dialog')!;
    for (const files of [[new File(['a'], 'a.txt'), new File(['b'], 'b.txt')], [new File(['abc'], 'big.txt', {type: 'text/plain'})], [new File(['a'], 'wrong.pdf', {type: 'application/pdf'})]]) {
        choose(dialog, files); submit(dialog); await vi.waitFor(() => {
            expect(dialog.querySelector('[data-form-error]')!.textContent).not.toBe('');
            expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
        });
    }
    expect(f.execute).not.toHaveBeenCalled(); dialog.querySelector<HTMLButtonElement>('[data-clear-files]')!.click(); submit(dialog);
    expect(await result).toEqual({documents: []});
});

it('does not guess distribution across multiple composer attachment fields or silently drop unused files', async () => {
    const file = new File(['selected'], 'notes.txt', {type: 'text/plain'}), fields = ['one', 'two'].map(name => ({...parameter, name, inputSource: 'composer.attachments' as const}));
    expect(agentFlowInput(fields, {text: '', files: [file]}).initialFiles).toEqual({});
    await expect(validateComposerFiles([file], {})).rejects.toMatchObject({code: 'FLOW_INPUT_UNBOUND_ATTACHMENTS'});
    await expect(validateComposerFiles([file], {documents: [{type: 'file', name: file.name, source: {type: 'asset', asset: {
        kind: 'input', id: '12345678-1234-4123-8123-123456789abc', mimeType: file.type, bytes: file.size, sha256: await sha256Hex(new TextEncoder().encode('selected')),
    }}}]})).resolves.toBeUndefined();
});

it('authors a file parameter, constraints and composer binding through the ordinary Flow settings dialog', async () => {
    const result = openFlowSettings({connections: [], availableConnections: [], parameters: [{name: 'documents', type: 'json'}]});
    const dialog = document.querySelector('dialog')!, widget = dialog.querySelector<HTMLSelectElement>('[data-param-widget]')!;
    widget.value = 'files'; widget.dispatchEvent(new Event('change', {bubbles: true}));
    expect(dialog.querySelector<HTMLElement>('[data-param-file-fields]')!.hidden).toBe(false);
    dialog.querySelector<HTMLSelectElement>('[data-param-source]')!.value = 'composer.attachments';
    dialog.querySelector<HTMLInputElement>('[data-param-files]')!.value = JSON.stringify(parameter.fileConstraints);
    dialog.returnValue = 'save'; dialog.close();
    expect((await result)?.parameters).toEqual([{name: 'documents', type: 'json', widget: 'files', inputSource: 'composer.attachments', fileConstraints: parameter.fileConstraints}]);
});
