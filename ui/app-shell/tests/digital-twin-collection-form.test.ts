// @vitest-environment jsdom
import {expect, it} from 'vitest';
import type {TwinScannerTool} from '@itookit/app-contracts';
import {collectionFields, readCollectionExecutor} from '../src/digital-twin/collection-fields';
import {scannerFieldChange} from '../src/digital-twin/scanner-fields';
import {collectionDestinationSummary} from '../src/digital-twin/collection-destination';

const tool: TwinScannerTool = {name: 'Resources', description: '', source: 'plugin', target: {kind: 'tool', id: 'fixture.resources', version: '1', digest: 'stable'},
    presentation: {advanced: ['limit'], optionLabels: {connection: {account: 'My account'}}, parameters: [
        {name: 'connection', label: 'Account', type: 'string', widget: 'select', options: ['account'], default: 'account'},
        {name: 'resource', label: 'Content', type: 'string'}]},
    parameters: {anyOf: [
        {title: 'Messages', type: 'object', required: ['resource', 'connection', 'query'], properties: {resource: {const: 'messages', type: 'string'},
            connection: {type: 'string'}, query: {type: 'string', default: 'recent'}, limit: {type: 'integer', minimum: 1, maximum: 20, default: 10}}},
        {title: 'Events', type: 'object', required: ['resource', 'connection'], properties: {resource: {const: 'events', type: 'string'},
            connection: {type: 'string'}, days: {type: 'integer', default: 7}}}]}};
function form(selected?: TwinScannerTool, values?: Record<string, string | number>) {
    const root = document.createElement('form'); root.dataset.form = 'scanPlan';
    root.innerHTML = collectionFields([], [tool], selected ? {target: selected.target, values} : undefined)
        + '<select name="inputMode"><option value="rules">Scope</option></select><textarea name="include"></textarea>'
        + '<select name="mode"><option value="analyze">Learn</option><option value="collect">Collect</option></select>'
        + '<div data-knowledge-settings><input name="focus"></div><div data-scanner-budget></div><div data-source-scope></div>';
    return root;
}
function field<T extends HTMLElement = HTMLInputElement>(root: HTMLElement, name: string): T {return root.querySelector<T>(`[name="scanner.collection.argument.${name}"]`)!;}
function change(root: HTMLElement, selector: string, value: string) {
    const control = root.querySelector<HTMLSelectElement>(selector)!; control.value = value;
    scannerFieldChange({target: control} as unknown as Event, [], [tool]);
}
it('explicitly saves an application workspace without treating tool arguments as write grants', () => {
    const root = form();
    expect(root.querySelector<HTMLElement>('[data-collection-destination]')!.hidden).toBe(true);
    change(root, '[name=collection]', JSON.stringify(Object.values(tool.target)));
    expect(root.querySelector<HTMLElement>('[data-collection-destination]')!.hidden).toBe(false);
    root.querySelector<HTMLSelectElement>('[name=collectionDestination]')!.value = 'emails';
    const selected = readCollectionExecutor(root, [], [tool])!;
    expect(selected.destination).toBe('emails'); expect(selected.values).not.toHaveProperty('directory');
    expect(collectionDestinationSummary(selected)).toContain('/home/admin/emails');
    root.innerHTML = collectionFields([], [tool], selected);
    expect(readCollectionExecutor(root, [], [tool])).toEqual(selected);
    const select = root.querySelector<HTMLSelectElement>('[name=collectionDestination]')!;
    select.add(new Option('Host path', '/home/li/nestos')); select.value = '/home/li/nestos';
    expect(() => readCollectionExecutor(root, [], [tool])).toThrow();
});
it('collects directly with a tagged schema, account choices and collapsed advanced fields, without requiring a model', () => {
    const root = form(); change(root, '[name=collection]', JSON.stringify(Object.values(tool.target)));
    expect(root.querySelector<HTMLSelectElement>('[name=mode]')!.value).toBe('collect');
    expect(root.querySelector<HTMLElement>('[data-knowledge-settings]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLSelectElement>('[data-collection-variant]')!.selectedOptions[0].text).toBe('Messages');
    expect(field<HTMLSelectElement>(root, 'connection').selectedOptions[0].text).toBe('My account');
    expect(field(root, 'limit').closest<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(field(root, 'days')).toBeNull();
    expect(readCollectionExecutor(root, [], [tool])).toEqual({target: tool.target, values: {connection: 'account', query: 'recent', limit: 10, resource: 'messages'}});
    field<HTMLInputElement>(root, 'limit').value = '21';
    expect(() => readCollectionExecutor(root, [], [tool])).toThrow();
});
it('switches resource branches, preserves drafts and common account fields, and submits only the active branch', () => {
    const root = form(tool); field<HTMLTextAreaElement>(root, 'query').value = 'custom range';
    change(root, '[data-collection-variant]', '1'); field(root, 'days').value = '14';
    expect(field(root, 'query')).toBeNull();
    expect(readCollectionExecutor(root, [], [tool])?.values).toEqual({connection: 'account', days: 14, resource: 'events'});
    change(root, '[data-collection-variant]', '0');
    expect(field<HTMLTextAreaElement>(root, 'query').value).toBe('custom range');
    change(root, '[data-collection-variant]', '1'); expect(field(root, 'days').value).toBe('14');
});
it('restores the saved resource branch and explicit settings instead of newer personal defaults', () => {
    const root = form(tool, {resource: 'events', days: 3, connection: 'removed-account'});
    expect(root.querySelector<HTMLSelectElement>('[data-collection-variant]')!.value).toBe('1');
    expect(readCollectionExecutor(root, [], [tool])?.values).toEqual({resource: 'events', days: 3, connection: 'removed-account'});
});
it('requires a deliberate branch selection when saved arguments name an unavailable resource', () => {
    const root = form(tool, {resource: 'removed-resource'});
    expect(root.querySelector<HTMLSelectElement>('[data-collection-variant]')!.value).toBe('-1');
    expect(() => readCollectionExecutor(root, [], [tool])).toThrow();
    change(root, '[data-collection-variant]', '0');
    expect(readCollectionExecutor(root, [], [tool])?.values?.resource).toBe('messages');
});
it('hides compatibility tools for new scanners while preserving editing of an existing target', () => {
    const hidden = {...tool, hidden: true};
    const root = document.createElement('form'); root.innerHTML = collectionFields([], [hidden]);
    expect(root.querySelector<HTMLSelectElement>('[name=collection]')!.options).toHaveLength(1);
    root.innerHTML = collectionFields([], [hidden], {target: hidden.target, values: {resource: 'events', days: 2}});
    expect(readCollectionExecutor(root, [], [hidden])?.values?.resource).toBe('events');
});
it('retains a JSON editor for schemas without a supported discriminator and rejects non-object arguments', () => {
    const complex = {...tool, presentation: undefined, parameters: {oneOf: [{type: 'object'}, {type: 'string'}]}};
    const root = document.createElement('form'); root.innerHTML = collectionFields([], [complex], {target: complex.target, values: {name: 'saved'}});
    expect(readCollectionExecutor(root, [], [complex])?.values).toEqual({name: 'saved'});
    root.querySelector<HTMLTextAreaElement>('[data-parameter]')!.value = '[]';
    expect(() => readCollectionExecutor(root, [], [complex])).toThrow();
});
