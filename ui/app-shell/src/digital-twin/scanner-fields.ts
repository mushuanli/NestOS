import {changeCollectionVariant, collectionKey, toolFields} from './collection-fields';
import type {TwinScannerTool} from '@itookit/app-contracts';
import {readUtf8File} from '../files/read-text-file';
import {escapeHTML, escapeAttr} from '@itookit/common';
import type {RootCallTarget} from '@itookit/llm-session/contracts';
import type {TwinScannerExecutor} from '@itookit/app-contracts';
import {renderParameterFields, readParameterFields} from '@itookit/llm-ui/forms';
import {label} from './view';
const key = (target: RootCallTarget['target']) => JSON.stringify([target.kind, target.id, target.version, target.digest]);
export function executorFields(targets: RootCallTarget[], selected?: TwinScannerExecutor, slot: 'executor' | 'collection' = 'executor'): string {
    if (slot === 'collection') targets = targets.filter(item => item.target.kind === 'flow');
    const missing = selected && !targets.some(item => key(item.target) === key(selected.target));
    return `<label>${escapeHTML(label(slot === 'collection' ? 'collectionFlow' : 'scannerExecutor'))}<select name="${slot}"><option value="">${escapeHTML(label(slot === 'collection' ? 'collectionNone' : 'scannerBuiltin'))}</option>
        ${missing ? `<option value="${escapeAttr(key(selected.target))}" selected>${escapeHTML(label('scannerTargetUnavailable'))}</option>` : ''}
        ${targets.map(item => `<option value="${escapeAttr(key(item.target))}" ${selected && key(item.target) === key(selected.target) ? 'selected' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.target.kind)} · ${escapeHTML(item.target.version)}</option>`).join('')}</select></label>
        <div data-scanner-parameters="${slot}">${parameterFields(targets.find(item => selected && key(item.target) === key(selected.target)), selected?.values, slot)}</div>
        ${slot === 'collection' ? `<p class="twin__help">${escapeHTML(label('collectionHelp'))}</p>` : `<details><summary>${escapeHTML(label('scannerResultMapping'))}</summary><p>${escapeHTML(label('scannerOutputHelp'))}</p><label>${escapeHTML(label('scannerOutputPath'))}<input name="outputPath" value="${escapeAttr(selected?.outputPath?.join('.') ?? '')}"></label></details>`}`;
}
export function updateExecutorMode(form: HTMLFormElement): void {
    const custom = !!form.querySelector<HTMLSelectElement>('[name=executor]')?.value;
    form.querySelectorAll<HTMLElement>('[data-scanner-builtin]').forEach(row => {row.hidden = custom;});
}
function parameterFields(target?: RootCallTarget, values?: TwinScannerExecutor['values'], slot = 'executor'): string {
    return renderParameterFields(target?.input?.parameters.filter(field => field.inputSource !== 'composer.text') ?? [], {mode: 'run', values, namePrefix: `scanner.${slot}.argument.`});
}
export function scannerFieldChange(event: Event, targets: RootCallTarget[], tools: TwinScannerTool[] = []): boolean {
    const control = event.target as HTMLSelectElement, form = control.closest<HTMLFormElement>('[data-form=scanPlan]');
    if (!form) return false;
    if (control instanceof HTMLSelectElement && changeCollectionVariant(control, tools)) return true;
    if (control.name === 'executor' || control.name === 'collection') {
        const tool = control.name === 'collection' && tools.find(item => collectionKey(item.target) === control.value);
        const selected = targets.find(item => key(item.target) === control.value);
        form.querySelector(`[data-scanner-parameters="${control.name}"]`)!.innerHTML = tool ? toolFields(tool) : parameterFields(selected, undefined, control.name);
        const destination = form.querySelector<HTMLElement>('[data-collection-destination]');
        if (control.name === 'collection' && destination) destination.hidden = !tool;
        if (control.name === 'collection' && control.value) {
            form.querySelector<HTMLSelectElement>('[name=inputMode]')!.value = 'rules';
            const operation = form.querySelector<HTMLSelectElement>('[name=mode]');
            if (operation) operation.value = 'collect';
        }
        updateExecutorMode(form); updateInputMode(form); return true;
    }
    if (control.name === 'trigger' || control.name === 'enabled' || control.name === 'mode') {updateInputMode(form); return true;}
    if (control.name !== 'inputMode') return false;
    updateInputMode(form); return true;
}
export function updateInputMode(form: HTMLFormElement): void {
    const input = form.querySelector<HTMLSelectElement>('[name=inputMode]');
    if (!input) return;
    const collection = !!form.querySelector<HTMLSelectElement>('[name=collection]')?.value;
    input.querySelectorAll('option').forEach(option => {option.disabled = collection && option.value !== 'rules';});
    if (collection) input.value = 'rules';
    const include = form.querySelector<HTMLTextAreaElement>('[name=include]');
    const operation = form.querySelector<HTMLSelectElement>('[name=mode]');
    const collectOption = operation?.querySelector<HTMLOptionElement>('[value=collect]');
    if (collectOption) collectOption.disabled = !collection;
    if (!collection && operation?.value === 'collect') operation.value = 'analyze';
    const collectOnly = operation?.value === 'collect';
    if (include) include.required = collection && !collectOnly;
    form.querySelectorAll<HTMLElement>('[data-knowledge-settings], [data-scanner-budget], [data-source-scope]').forEach(row => {
        row.hidden = collectOnly;
        row.querySelectorAll<HTMLInputElement>('input, select, textarea').forEach(control => {control.disabled = collectOnly;});
    });
    updateTriggerMode(form, collection);
    form.querySelectorAll<HTMLElement>('[data-input-mode]').forEach(row => {row.hidden = row.dataset.inputMode !== input.value;});
}
function updateTriggerMode(form: HTMLFormElement, collection: boolean): void {
    const trigger = form.querySelector<HTMLSelectElement>('[name=trigger]');
    const changes = trigger?.querySelector<HTMLOptionElement>('[value=changes]');
    if (changes) changes.disabled = collection;
    if (collection && trigger?.value === 'changes') trigger.value = 'interval';
    const interval = form.querySelector<HTMLElement>('[data-scanner-interval]');
    const run = form.querySelector<HTMLButtonElement>('[data-run-scanner]');
    if (run) run.disabled = !form.querySelector<HTMLInputElement>('[name=enabled]')?.checked;
    if (interval) interval.hidden = ['manual', 'event'].includes(trigger?.value ?? 'manual');
}

export function readScannerExecutor(form: HTMLFormElement, targets: RootCallTarget[], slot: 'executor' | 'collection' = 'executor'): TwinScannerExecutor | undefined {
    const value = form.querySelector<HTMLSelectElement>(`[name=${slot}]`)!.value;
    if (!value) return;
    const selected = targets.find(item => key(item.target) === value);
    if (!selected) throw new Error(label('scannerTargetUnavailable'));
    const parameters = selected.input?.parameters.filter(field => field.inputSource !== 'composer.text') ?? [];
    const values = readParameterFields(form.querySelector<HTMLElement>(`[data-scanner-parameters="${slot}"]`)!, parameters, {mode: 'run'});
    const path = slot === 'executor' ? form.querySelector<HTMLInputElement>('[name=outputPath]')!.value.trim() : '';
    return {target: selected.target, values, ...(path ? {outputPath: path.split('.')} : {})};
}

export async function readScannerFile(file: File): Promise<string> {
    if (file.size > 128 * 1024) throw new Error(label('scannerUploadInvalid'));
    return readUtf8File(file);
}
