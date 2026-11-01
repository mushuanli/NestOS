import {escapeHTML, escapeAttr} from '@itookit/common';
import type {TwinCollectionExecutor, TwinScannerTool} from '@itookit/app-contracts';
import type {RootCallTarget} from '@itookit/llm-session/contracts';
import {renderParameterFields, readParameterFields} from '@itookit/llm-ui/forms';
import {executorFields, readScannerExecutor} from './scanner-fields';
import {collectionParameters, collectionVariant, selectedCollectionBranch} from './collection-schema';
import {label} from './view';
import {collectionDestinationFields, readCollectionDestination, type CollectionProject} from './collection-destination';
export const collectionKey = (target: {kind: string; id: string; version: string; digest: string}) => JSON.stringify([target.kind, target.id, target.version, target.digest]);
export function collectionFields(targets: RootCallTarget[], tools: TwinScannerTool[], selected?: TwinCollectionExecutor, projects: CollectionProject[] = []): string {
    const tool = tools.find(item => selected && collectionKey(item.target) === collectionKey(selected.target));
    const host = executorFields(targets, selected?.target.kind === 'tool' ? undefined : selected as import('@itookit/app-contracts').TwinScannerExecutor | undefined, 'collection');
    const options = tools.filter(item => !item.hidden || tool === item).map(item => `<option value="${escapeAttr(collectionKey(item.target))}" ${tool === item ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('');
    const base = selected ? host : host.replace('<option value="">', '<option value="" selected>');
    let html = base.replace('<select name="collection">', '<select name="collection">' + options);
    if (selected?.target.kind === 'tool' && !tool) html = html.replace('<select name="collection">', `<select name="collection"><option selected value="${escapeAttr(collectionKey(selected.target))}">${escapeHTML(label('scannerTargetUnavailable'))}</option>`);
    if (tool) html = html.replace('<div data-scanner-parameters="collection"></div>', `<div data-scanner-parameters="collection">${toolFields(tool, selected?.values)}</div>`);
    return html + collectionDestinationFields(selected, projects);
}
export function toolFields(tool: TwinScannerTool, values?: TwinCollectionExecutor['values'], index = selectedCollectionBranch(tool, values)): string {
    const parameters = collectionParameters(tool, index), variant = collectionVariant(tool);
    const merged = {...tool.defaults, ...values};
    const fields = renderParameterFields(parameters, {mode: 'run', values: parameters[0]?.name === '$arguments' ? {$arguments: merged} : merged,
        namePrefix: 'scanner.collection.argument.', optionLabel: (value, field) => tool.presentation?.optionLabels?.[field.name]?.[String(value)] ?? String(value),
        renderField: (field, fieldIndex, render) => `<div data-collection-field="${fieldIndex}"${tool.presentation?.advanced?.includes(field.name) ? ' data-collection-advanced' : ''}>${render()}</div>`});
    const host = document.createElement('div'); host.innerHTML = fields;
    const advanced = [...host.querySelectorAll('[data-collection-advanced]')].map(node => {node.remove(); return node.outerHTML;}).join('');
    const selector = variant ? `<label>${escapeHTML(tool.presentation?.parameters.find(field => field.name === variant.key)?.label ?? variant.key)}<select name="scanner.collection.variant" data-collection-variant>
        ${index < 0 ? `<option value="-1" selected>${escapeHTML(label('scannerTargetUnavailable'))}</option>` : ''}${variant.branches.map((branch, i) => `<option value="${i}"${i === index ? ' selected' : ''}>${escapeHTML(branch.title ?? tool.presentation?.optionLabels?.[variant.key]?.[String(variant.values[i])] ?? String(variant.values[i]))}</option>`).join('')}</select></label>` : '';
    return `<div data-collection-tool-fields data-collection-branch="${index}">${selector}${host.innerHTML}${advanced ? `<details><summary>${escapeHTML(label('advanced'))}</summary>${advanced}</details>` : ''}</div>`;
}
export function readCollectionExecutor(form: HTMLFormElement, targets: RootCallTarget[], tools: TwinScannerTool[]): TwinCollectionExecutor | undefined {
    const value = form.querySelector<HTMLSelectElement>('[name=collection]')!.value;
    const tool = tools.find(item => collectionKey(item.target) === value);
    if (!tool) return readScannerExecutor(form, targets, 'collection');
    const root = form.querySelector<HTMLElement>('[data-scanner-parameters=collection]')!;
    const index = Number(root.querySelector<HTMLElement>('[data-collection-branch]')?.dataset.collectionBranch ?? 0);
    const variant = collectionVariant(tool);
    if (variant && (!Number.isInteger(index) || !variant.branches[index])) throw new Error(label('scannerResourceUnavailable'));
    let values = readParameterFields(root, collectionParameters(tool, index), {mode: 'run'});
    if (Object.hasOwn(values, '$arguments')) {
        const args = values.$arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(label('scannerArgumentsInvalid'));
        values = args;
    }
    if (variant) values[variant.key] = variant.values[index];
    const destination = readCollectionDestination(form);
    return {target: tool.target, values, ...destination};
}

type DraftField = {name: string; value: string; checked?: boolean};
const branchDrafts = new WeakMap<HTMLElement, {key: string; drafts: Map<number, DraftField[]>}>();
export function changeCollectionVariant(control: HTMLSelectElement, tools: TwinScannerTool[]): boolean {
    if (!control.hasAttribute('data-collection-variant')) return false;
    const form = control.closest<HTMLFormElement>('form')!, host = control.closest<HTMLElement>('[data-scanner-parameters=collection]')!;
    const selected = form.querySelector<HTMLSelectElement>('[name=collection]')!.value;
    const tool = tools.find(item => collectionKey(item.target) === selected);
    if (!tool) return false;
    const previous = Number(host.querySelector<HTMLElement>('[data-collection-branch]')!.dataset.collectionBranch), next = Number(control.value);
    const cached = branchDrafts.get(host), drafts = cached?.key === selected ? cached.drafts : new Map<number, DraftField[]>();
    const fields = [...host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-parameter]')];
    const snapshot = fields.map(field => ({name: field.name, value: field.value, ...(field instanceof HTMLInputElement ? {checked: field.checked} : {})}));
    drafts.set(previous, snapshot); branchDrafts.set(host, {key: selected, drafts});
    const common = new Set(collectionParameters(tool, next).map(field => 'scanner.collection.argument.' + field.name));
    host.innerHTML = toolFields(tool, undefined, next);
    const restore = [...drafts.get(next) ?? [], ...snapshot.filter(field => common.has(field.name))];
    for (const saved of restore) {
        const field = [...host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-parameter]')].find(item => item.name === saved.name);
        if (field) {field.value = saved.value; if (field instanceof HTMLInputElement && saved.checked !== undefined) field.checked = saved.checked;}
    }
    host.querySelector<HTMLSelectElement>('[data-collection-variant]')?.focus();
    return true;
}
