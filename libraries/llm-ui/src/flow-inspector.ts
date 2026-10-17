import type { JsonValue } from './contracts';
import type { FlowField, FlowInspectorContext, MountedFlowInspector } from './flow-contracts';
import { button, element, errorText } from './dom';

export function mountFlowInspector(container: HTMLElement, context: FlowInspectorContext,
    t: (key: string) => string): MountedFlowInspector {
    const form = element('form', 'llm-flow__form'), name = element('input'); name.value = context.node.name;
    const label = element('label', undefined, t('name')); label.append(name); form.append(label);
    const fields = context.snapshot.nodeTypes.find(type => type.id === context.node.type)?.fields ?? [];
    const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    for (const field of fields) {
        const control = fieldControl(field, context.node.config[field.id]); controls.set(field.id, control);
        const row = element('label', undefined, field.label); row.append(control); form.append(row);
    }
    const feedback = element('p', 'llm-flow__error'), save = button(t('apply'), () => {}); save.type = 'submit';
    form.append(save, feedback); container.append(form);
    if (!context.canEdit) form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true; });
    let closed = false, working = false;
    form.addEventListener('submit', event => {
        event.preventDefault(); if (working) return;
        void (async () => {
            working = true; save.disabled = true;
            try {
                const config = { ...context.node.config };
                for (const field of fields) config[field.id] = fieldValue(field, controls.get(field.id)!);
                await context.commit({ name: name.value, config }); feedback.textContent = t('accepted');
            } catch (error) { if (!closed) feedback.textContent = errorText(error); }
            finally { working = false; if (!closed) save.disabled = false; }
        })();
    });
    return { destroy() { closed = true; form.remove(); } };
}
function fieldControl(field: FlowField, value: JsonValue | undefined) {
    const control = field.kind === 'json' ? element('textarea') : field.kind === 'choice' ? element('select') : element('input');
    control.name = field.id; control.required = field.required ?? false;
    if (control instanceof HTMLInputElement) { control.type = field.kind === 'boolean' ? 'checkbox' : field.kind === 'number' ? 'number' : 'text'; control.checked = value === true; }
    if (field.kind === 'choice') for (const choice of field.choices) {
        const option = element('option', undefined, choice.label); option.value = choice.id; control.append(option);
    }
    control.value = field.kind === 'json' ? JSON.stringify(value ?? null, null, 2) : String(value ?? '');
    return control;
}
function fieldValue(field: FlowField, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): JsonValue {
    if (field.kind === 'boolean') return (control as HTMLInputElement).checked;
    if (field.kind === 'number') {
        const value = Number(control.value); if (!control.value.trim() || !Number.isFinite(value)) throw new Error(`Invalid number: ${field.label}`);
        return value;
    }
    if (field.kind === 'json') return JSON.parse(control.value) as JsonValue;
    return control.value;
}
