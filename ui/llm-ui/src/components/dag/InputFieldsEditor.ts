import { escapeHTML, t } from '@itookit/common';

type Fields = Record<string, Record<string, unknown>>;

/** Edit a field map visually while retaining the schema form's serialization boundary. */
export function enhanceInputFieldsEditor(root: HTMLElement, config: Record<string, unknown>): void {
    const key = config.param ? 'param' : config.fields ? 'fields' : 'param';
    const source = root.querySelector<HTMLTextAreaElement>(`[data-schema-path="$.${key}"]`);
    if (!source) return;
    let fields: Fields = structuredClone((config[key] ?? {}) as Fields);
    const editor = document.createElement('div');
    for (const name of ['param', 'fields']) {
        const input = root.querySelector<HTMLTextAreaElement>(`[data-schema-path="$.${name}"]`);
        if (input?.parentElement) input.parentElement.hidden = true;
    }
    source.parentElement!.before(editor);
    const render = () => { editor.innerHTML = `${Object.entries(fields).map(fieldRow).join('')}<button type="button" data-add-field>${escapeHTML(t('flow.editor.addField'))}</button>`; };
    editor.addEventListener('change', () => {
        try { source.value = JSON.stringify(readFields(editor, fields)); }
        catch { source.value = '{'; }
    });
    editor.addEventListener('click', event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!button) return;
        try { fields = readFields(editor, fields); } catch { return; }
        if (button.hasAttribute('data-remove-field')) delete fields[button.closest('fieldset')!.querySelector<HTMLInputElement>('[data-field="name"]')!.value.trim()];
        else if (button.hasAttribute('data-add-field')) { let i = 1; while (fields[`field${i}`]) i++; fields[`field${i}`] = { type: 'string', widget: 'text', required: true }; }
        source.value = JSON.stringify(fields); render();
    });
    render();
}
function fieldRow([name, field]: [string, Record<string, unknown>]): string {
    const select = (key: string, options: string[]) => `<select data-field="${key}">${options.map(value => `<option ${field[key] === value ? 'selected' : ''}>${value}</option>`).join('')}</select>`;
    return `<fieldset data-field-name="${escapeHTML(name)}"><legend>${escapeHTML(name)}</legend>
        <label>${escapeHTML(t('flow.editor.fieldName'))}<input data-field="name" value="${escapeHTML(name)}"></label>
        <label>${escapeHTML(t('flow.editor.fieldLabel'))}<input data-field="label" value="${escapeHTML(String(field.label ?? ''))}"></label>
        <label>${escapeHTML(t('flow.editor.fieldType'))}${select('type', ['string', 'number', 'boolean', 'json'])}</label>
        <label>${escapeHTML(t('flow.editor.widget'))}${select('widget', ['text', 'textarea', 'number', 'select', 'checkbox'])}</label>
        <label>${escapeHTML(t('flow.editor.required'))}<input type="checkbox" data-field="required" ${field.required !== false ? 'checked' : ''}></label>
        <label>${escapeHTML(t('flow.editor.defaultValue'))}<input data-field="default" value="${escapeHTML(field.default === undefined ? '' : JSON.stringify(field.default))}"></label>
        <label>${escapeHTML(t('flow.editor.choices'))}<input data-field="options" value="${escapeHTML(field.options === undefined ? '' : JSON.stringify(field.options))}"></label>
        <button type="button" data-remove-field="${escapeHTML(name)}">${escapeHTML(t('flow.editor.removeField'))}</button></fieldset>`;
}
function readFields(editor: HTMLElement, previous: Fields): Fields {
    const result: Fields = {};
    for (const row of editor.querySelectorAll<HTMLElement>('[data-field-name]')) {
        const read = (name: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`)!.value;
        const name = read('name').trim();
        if (!/^[A-Za-z][\w-]*$/.test(name) || ['constructor', 'prototype'].includes(name) || Object.hasOwn(result, name)) throw new Error('Invalid field name');
        const field = { ...previous[row.dataset.fieldName!], type: read('type'), widget: read('widget'), label: read('label'),
            required: row.querySelector<HTMLInputElement>('[data-field="required"]')!.checked };
        for (const key of ['default', 'options']) {
            delete (field as Record<string, unknown>)[key];
            if (read(key).trim()) (field as Record<string, unknown>)[key] = JSON.parse(read(key));
        }
        if (field.type !== 'string') delete (field as Record<string, unknown>).nonBlank;
        result[name] = field;
    }
    return result;
}
