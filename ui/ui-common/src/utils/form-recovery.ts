import {randomUUID, t} from '@itookit/common';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
interface Value {key: string; value: string; checked?: boolean;}
const fields = (root: HTMLElement): Field[] => [...root.querySelectorAll<Field>('input:not([type="file"]), textarea, select')];
const key = (field: Field) => JSON.stringify([field.tagName, field.type, field.name, field.id]);

/** Memory-only form snapshots include secrets; never persist or log them. */
export function captureForm(root: HTMLElement): Value[] {
    return fields(root).map(field => ({key: key(field), value: field.value,
        checked: field instanceof HTMLInputElement ? field.checked : undefined}));
}
export function restoreForm(root: HTMLElement, values: Value[]): void {
    const controls = fields(root);
    const mismatch = controls.findIndex((field, index) => key(field) !== values[index]?.key);
    if (controls.length !== values.length || mismatch !== -1) {
        console.warn('settings.form.recovery', {operation: 'settings.form.restore', operationId: randomUUID(), stage: 'structure',
            outcome: 'failure', code: 'RECOVERY_FORM_CHANGED', expectedFields: values.length, actualFields: controls.length,
            mismatchedIndex: mismatch, durationMs: 0});
        throw Object.assign(new Error(t('httpApp.recoveryFormChanged')), {code: 'RECOVERY_FORM_CHANGED'});
    }
    controls.forEach((field, index) => {
        field.value = values[index].value;
        if (field instanceof HTMLInputElement && values[index].checked !== undefined) field.checked = values[index].checked!;
    });
}
