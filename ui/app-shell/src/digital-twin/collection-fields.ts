import {escapeHTML, escapeAttr} from '@itookit/common';
import type {TwinCollectionExecutor, TwinScannerTool} from '@itookit/app-contracts';
import type {RootCallTarget} from '@itookit/llm-session/contracts';
import {renderParameterFields, readParameterFields} from '@itookit/llm-ui/forms';
import {executorFields, readScannerExecutor} from './scanner-fields';
import {label} from './view';
export const collectionKey = (target: {kind: string; id: string; version: string; digest: string}) => JSON.stringify([target.kind, target.id, target.version, target.digest]);
export function collectionFields(targets: RootCallTarget[], tools: TwinScannerTool[], selected?: TwinCollectionExecutor): string {
    const tool = tools.find(item => selected && collectionKey(item.target) === collectionKey(selected.target));
    const host = executorFields(targets, selected?.target.kind === 'tool' ? undefined : selected as import('@itookit/app-contracts').TwinScannerExecutor | undefined, 'collection');
    const options = tools.map(item => `<option value="${escapeAttr(collectionKey(item.target))}" ${tool === item ? 'selected' : ''}>${escapeHTML(item.name)} · Tool · ${escapeHTML(item.target.version)}</option>`).join('');
    const base = selected ? host : host.replace('<option value="">', '<option value="" selected>');
    let html = base.replace('<select name="collection">', '<select name="collection">' + options);
    if (selected?.target.kind === 'tool' && !tool) html = html.replace('<select name="collection">', `<select name="collection"><option selected value="${escapeAttr(collectionKey(selected.target))}">${escapeHTML(label('scannerTargetUnavailable'))}</option>`);
    if (tool) html = html.replace('<div data-scanner-parameters="collection"></div>', `<div data-scanner-parameters="collection">${toolFields(tool, selected?.values)}</div>`);
    return html;
}
export function toolFields(tool: TwinScannerTool, values?: TwinCollectionExecutor['values']): string {
    return renderParameterFields(toolParameters(tool), {mode: 'run', values: {...tool.defaults, ...values}, namePrefix: 'scanner.collection.argument.'});
}
export function readCollectionExecutor(form: HTMLFormElement, targets: RootCallTarget[], tools: TwinScannerTool[]): TwinCollectionExecutor | undefined {
    const value = form.querySelector<HTMLSelectElement>('[name=collection]')!.value;
    const tool = tools.find(item => collectionKey(item.target) === value);
    if (!tool) return readScannerExecutor(form, targets, 'collection');
    const values = readParameterFields(form.querySelector<HTMLElement>('[data-scanner-parameters=collection]')!, toolParameters(tool), {mode: 'run'});
    return {target: tool.target, values};
}
function toolParameters(tool: TwinScannerTool): Parameters<typeof renderParameterFields>[0] {
    const schema = tool.parameters as {required?: string[]; properties?: Record<string, Record<string, unknown>>};
    return Object.entries(schema.properties ?? {}).map(([name, field]) => ({name, label: typeof field.title === 'string' ? field.title : name,
        description: typeof field.description === 'string' ? field.description : undefined,
        type: field.type === 'integer' || field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : field.type === 'string' ? 'string' : 'json',
        integer: field.type === 'integer', required: schema.required?.includes(name), default: field.default as never,
        minimum: typeof field.minimum === 'number' ? field.minimum : undefined, maximum: typeof field.maximum === 'number' ? field.maximum : undefined,
        options: Array.isArray(field.enum) ? field.enum as never[] : undefined,
    }));
}
