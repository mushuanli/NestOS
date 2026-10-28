// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {executorFields, readScannerExecutor, scannerFieldChange, readScannerFile} from '../src/digital-twin/scanner-fields';
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
