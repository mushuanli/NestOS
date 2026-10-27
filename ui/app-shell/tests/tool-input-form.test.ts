// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it} from 'vitest';
import {promptToolCall} from '../../llm-ui-adapter/src/flows/tool-call-form';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
});
afterEach(() => document.body.replaceChildren());

it('collects schema arguments without executing and cancels when its owner closes', async () => {
    const options = [{id: 'mcp__knowledge__search', name: 'Knowledge / Search', parameters: {
        type: 'object', required: ['query'], properties: {query: {type: 'string', minLength: 1}},
    }}];
    const result = promptToolCall(options);
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
    const select = dialog.querySelector<HTMLSelectElement>('[data-tool]')!;
    select.value = options[0].id; select.dispatchEvent(new Event('change'));
    const form = dialog.querySelector('form')!;
    form.dispatchEvent(new Event('submit', {cancelable: true}));
    expect(dialog.open).toBe(true);
    dialog.querySelector<HTMLInputElement>('[data-schema-path="$.query"]')!.value = 'recent';
    form.dispatchEvent(new Event('submit', {cancelable: true}));
    expect(await result).toEqual({toolId: options[0].id, toolVersion: '1', args: {query: 'recent'}});
    const owner = new AbortController(), cancelled = promptToolCall(options, {signal: owner.signal});
    owner.abort();
    expect(await cancelled).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
});
