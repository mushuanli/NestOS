// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {executorFields, readScannerExecutor, scannerFieldChange, readScannerFile} from '../src/digital-twin/scanner-fields';
import {sourceConnectionSettings, importConnection} from '../src/configuration/tool-connections';
import type {RootCallTarget} from '@itookit/llm-session/contracts';
const targets: RootCallTarget[] = [{target: {kind: 'flow', id: 'reader', version: '1', digest: 'digest'}, name: 'Reader',
    input: {flowId: 'reader', revision: 1, digest: 'digest', parameters: [{name: 'body', type: 'string', inputSource: 'composer.text'},
        {name: 'count', type: 'number', required: true, default: 3}]}}];
it('uses the selected published target parameter schema and excludes the composer-bound text field', () => {
    const form = document.createElement('form'); form.dataset.form = 'scanPlan'; form.innerHTML = executorFields(targets);
    const select = form.querySelector<HTMLSelectElement>('[name=executor]')!; select.selectedIndex = 1;
    scannerFieldChange({target: select} as unknown as Event, targets);
    expect(form.querySelectorAll('[data-parameter]')).toHaveLength(1);
    const count = form.querySelector<HTMLInputElement>('[data-parameter]')!; count.value = '5';
    expect(readScannerExecutor(form, targets)).toEqual({target: targets[0].target, values: {count: 5}});
    count.value = '';
    expect(() => readScannerExecutor(form, targets)).toThrow();
});
it('preserves an unavailable configured target and rejects submission instead of silently using built-in extraction', () => {
    const form = document.createElement('form'); form.innerHTML = executorFields([], {target: targets[0].target});
    expect(() => readScannerExecutor(form, [])).toThrow();
});
it('reads UTF-8 upload snapshots and rejects oversized and invalid encoded files', async () => {
    expect(await readScannerFile(new File(['hello'], 'note.txt', {type: 'text/plain'}))).toBe('hello');
    await expect(readScannerFile(new File([new Uint8Array([0xff])], 'binary.txt'))).rejects.toThrow();
    await expect(readScannerFile(new File(['a'.repeat(128 * 1024 + 1)], 'large.txt'))).rejects.toThrow();
});

it('imports authorization fields locally without exposing a saved secret or mutating fields on invalid input', async () => {
    const host = document.createElement('div'); document.body.append(host);
    host.innerHTML = sourceConnectionSettings({types: [{id: 'fixture', name: 'Fixture', description: '', fields: [{name: 'token', label: 'Token', secret: true}]}], connections: []});
    const control = host.querySelector<HTMLInputElement>('[name=connectionImport]')!, token = host.querySelector<HTMLInputElement>('[name=token]')!;
    try {
        Object.defineProperty(control, 'files', {configurable: true, value: [new File(['{"token":"imported-private"}'], 'connection.json')]});
        await importConnection(control); expect(token.value).toBe('imported-private');
        Object.defineProperty(control, 'files', {configurable: true, value: [new File(['{"token":4}'], 'bad.json')]});
        await expect(importConnection(control)).rejects.toThrow(); expect(token.value).toBe('imported-private');
        Object.defineProperty(control, 'files', {configurable: true, value: [new File(['a'.repeat(64 * 1024 + 1)], 'large.json')]});
        await expect(importConnection(control)).rejects.toThrow();
    } finally {host.remove();}
});

it('selects a direct Tool without a Flow and keeps collection-only settings separate from knowledge processing', async () => {
    const {collectionFields, readCollectionExecutor} = await import('../src/digital-twin/collection-fields');
    const {updateInputMode} = await import('../src/digital-twin/scanner-fields');
    const tool = {name: 'Fixture', description: '', source: 'plugin' as const, target: {kind: 'tool' as const, id: 'fixture.collect', version: '1', digest: 'digest'},
        parameters: {type: 'object', required: ['count'], properties: {count: {type: 'integer', minimum: 1, maximum: 10}, name: {type: 'string'}}}};
    const form = document.createElement('form'); form.dataset.form = 'scanPlan';
    form.innerHTML = collectionFields([], [tool]) + '<select name="inputMode"><option value="rules">Scope</option></select><textarea name="include"></textarea><select name="mode"><option value="analyze">Analyze</option><option value="collect">Collect</option></select><div data-knowledge-settings></div><div data-scanner-budget></div>';
    const selection = form.querySelector<HTMLSelectElement>('[name=collection]')!;
    expect(selection.value).toBe(''); selection.selectedIndex = 0; selection.dispatchEvent(new Event('change'));
    scannerFieldChange({target: selection} as unknown as Event, [], [tool]);
    form.querySelector<HTMLInputElement>('[data-parameter="0"]')!.value = '3';
    form.querySelector<HTMLInputElement>('[data-parameter="1"]')!.value = 'tool argument';
    expect(readCollectionExecutor(form, [], [tool])).toEqual({target: tool.target, values: {count: 3, name: 'tool argument'}});
    const mode = form.querySelector<HTMLSelectElement>('[name=mode]')!; mode.value = 'collect'; updateInputMode(form);
    expect(form.querySelector<HTMLTextAreaElement>('[name=include]')!.required).toBe(false);
    expect(form.querySelector<HTMLElement>('[data-knowledge-settings]')!.hidden).toBe(true);
    form.querySelector<HTMLInputElement>('[data-parameter="0"]')!.value = '0';
    expect(() => readCollectionExecutor(form, [], [tool])).toThrow();
});

it('prefills user defaults for direct Tool collectors and preserves explicit scanner values', async () => {
    const {toolFields} = await import('../src/digital-twin/collection-fields');
    const tool = {name: 'Fixture', description: '', source: 'plugin' as const, target: {kind: 'tool' as const, id: 'fixture.collect', version: '1', digest: 'stable'},
        defaults: {directory: 'personal-imports', count: 2}, parameters: {type: 'object', properties: {directory: {type: 'string'}, count: {type: 'integer'}}}};
    const form = document.createElement('form'); form.innerHTML = toolFields(tool, {count: 4});
    expect(form.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!.value).toBe('personal-imports');
    expect(form.querySelector<HTMLInputElement>('[data-parameter="1"]')!.value).toBe('4');
});
