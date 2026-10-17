import type { JsonValue } from './contracts';
import type { FlowField, FlowInspectorContext, MountedFlowInspector } from './flow-contracts';
import { element, errorText } from './dom';

export function mountFlowInspector(container: HTMLElement, context: FlowInspectorContext,
    t: (key: string) => string): MountedFlowInspector {
    return new FlowInspector(container, context, t);
}
class FlowInspector implements MountedFlowInspector {
    private readonly form = element('form', 'llm-flow__form');
    private readonly name = element('input');
    private readonly feedback = element('p', 'llm-flow__error');
    private readonly fields: readonly FlowField[];
    private readonly controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    private closed = false;
    private working = false;
    constructor(container: HTMLElement, private readonly context: FlowInspectorContext, private readonly t: (key: string) => string) {
        this.name.value = context.node.name;
        const label = element('label', undefined, t('name')); label.append(this.name); this.form.append(label);
        this.fields = context.snapshot.nodeTypes.find(type => type.id === context.node.type)?.fields ?? [];
        for (const field of this.fields) {
            const control = fieldControl(field, context.node.config[field.id]); this.controls.set(field.id, control);
            const row = element('label', undefined, field.label); row.append(control); this.form.append(row);
        }
        const save = element('button', undefined, t('apply')); save.type = 'submit';
        this.form.append(save, this.feedback); container.append(this.form); this.setWorking(false);
        this.form.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
    }
    private setWorking(value: boolean): void {
        this.working = value;
        this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,select,textarea,button')
            .forEach(control => { control.disabled = value || !this.context.canEdit; });
    }
    private async submit(): Promise<void> {
        if (this.closed || this.working || !this.context.canEdit) return;
        this.setWorking(true);
        try {
            const config = { ...this.context.node.config };
            for (const field of this.fields) config[field.id] = fieldValue(field, this.controls.get(field.id)!);
            await this.context.commit({ name: this.name.value, config });
            if (!this.closed) this.feedback.textContent = this.t('accepted');
        } catch (error) { if (!this.closed) this.feedback.textContent = errorText(error); }
        finally { if (!this.closed) this.setWorking(false); }
    }
    destroy(): void { this.closed = true; this.form.remove(); }
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
