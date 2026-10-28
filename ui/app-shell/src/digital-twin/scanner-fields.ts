import {escapeHTML, escapeAttr} from '@itookit/common';
import type {RootCallTarget} from '@itookit/llm-session/contracts';
import type {TwinScannerExecutor} from '@itookit/app-contracts';
import {renderParameterFields, readParameterFields} from '@itookit/llm-ui/forms';
import {label} from './view';
const key = (target: RootCallTarget['target']) => JSON.stringify([target.kind, target.id, target.version, target.digest]);
export function executorFields(targets: RootCallTarget[], selected?: TwinScannerExecutor): string {
    const missing = selected && !targets.some(item => key(item.target) === key(selected.target));
    return `<label>${escapeHTML(label('scannerExecutor'))}<select name="executor"><option value="">${escapeHTML(label('scannerBuiltin'))}</option>
        ${missing ? `<option value="${escapeAttr(key(selected.target))}" selected>${escapeHTML(label('scannerTargetUnavailable'))}</option>` : ''}
        ${targets.map(item => `<option value="${escapeAttr(key(item.target))}" ${selected && key(item.target) === key(selected.target) ? 'selected' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.target.kind)} · ${escapeHTML(item.target.version)}</option>`).join('')}</select></label>
        <p>${escapeHTML(label('scannerOutputHelp'))}</p><div data-scanner-parameters>${parameterFields(targets.find(item => selected && key(item.target) === key(selected.target)), selected?.values)}</div>
        <details><summary>${escapeHTML(label('advanced'))}</summary><label>${escapeHTML(label('scannerOutputPath'))}<input name="outputPath" value="${escapeAttr(selected?.outputPath?.join('.') ?? '')}"></label></details>`;
}
export function updateExecutorMode(form: HTMLFormElement): void {
    const custom = !!form.querySelector<HTMLSelectElement>('[name=executor]')?.value;
    form.querySelectorAll<HTMLElement>('[data-scanner-builtin]').forEach(row => {row.hidden = custom;});
}
function parameterFields(target?: RootCallTarget, values?: TwinScannerExecutor['values']): string {
    return renderParameterFields(target?.input?.parameters.filter(field => field.inputSource !== 'composer.text') ?? [], {mode: 'run', values, namePrefix: 'scanner.argument.'});
}
export function scannerFieldChange(event: Event, targets: RootCallTarget[]): boolean {
    const control = event.target as HTMLSelectElement, form = control.closest<HTMLFormElement>('[data-form=scanPlan]');
    if (!form) return false;
    if (control.name === 'executor') {
        const selected = targets.find(item => key(item.target) === control.value);
        form.querySelector('[data-scanner-parameters]')!.innerHTML = parameterFields(selected);
        updateExecutorMode(form); return true;
    }
    if (control.name !== 'inputMode') return false;
    updateInputMode(form); return true;
}
export function updateInputMode(form: HTMLFormElement): void {
    const mode = form.querySelector<HTMLSelectElement>('[name=inputMode]')!.value;
    form.querySelectorAll<HTMLElement>('[data-input-mode]').forEach(row => {row.hidden = row.dataset.inputMode !== mode;});
}
export function readScannerExecutor(form: HTMLFormElement, targets: RootCallTarget[]): TwinScannerExecutor | undefined {
    const value = form.querySelector<HTMLSelectElement>('[name=executor]')!.value;
    if (!value) return;
    const selected = targets.find(item => key(item.target) === value);
    if (!selected) throw new Error(label('scannerTargetUnavailable'));
    const parameters = selected.input?.parameters.filter(field => field.inputSource !== 'composer.text') ?? [];
    const values = readParameterFields(form.querySelector<HTMLElement>('[data-scanner-parameters]')!, parameters, {mode: 'run'});
    const path = form.querySelector<HTMLInputElement>('[name=outputPath]')!.value.trim();
    return {target: selected.target, values, ...(path ? {outputPath: path.split('.')} : {})};
}

export async function readScannerFile(file: File): Promise<string> {
    if (file.size > 128 * 1024) throw new Error(label('scannerUploadInvalid'));
    const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error(label('scannerUploadInvalid'))); reader.readAsArrayBuffer(file);
    });
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
