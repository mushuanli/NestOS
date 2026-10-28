import {resolveFlowExpression, type FlowConnection, type FlowParameter, type JsonValue} from '@itookit/llm-flow/contracts';

/** Group only presentation nodes; parameter/slot indices and submitted values remain unchanged. */
export function groupFlowParameterFields(markup: string, parameters: FlowParameter[], slots: FlowConnection[] = []): string {
    const root = document.createElement('div'); root.innerHTML = markup;
    const groups = new Map<string, HTMLElement>();
    const move = (row: HTMLElement | null, name?: string) => {
        if (!row || !name) return;
        let fields = groups.get(name);
        if (!fields) {
            const group = document.createElement('fieldset'), legend = document.createElement('legend');
            group.className = 'flow-parameter-group'; legend.textContent = name;
            fields = document.createElement('div'); fields.className = 'flow-parameter-section__fields';
            group.append(legend, fields); row.before(group); groups.set(name, fields);
        }
        fields.append(row);
    };
    parameters.forEach((field, index) => move(root.querySelector(`[data-parameter-row="${index}"]`), field.presentation?.group));
    slots.forEach((slot, index) => move(root.querySelector(`[data-slot-row="${index}"]`), slot.presentation?.group));
    return root.innerHTML;
}

export function applyFlowParameterVisibility(root: HTMLElement, parameters: FlowParameter[], values: Record<string, JsonValue>): void {
    parameters.forEach((field, index) => {
        if (!field.presentation?.visibleWhen) return;
        const row = root.querySelector<HTMLElement>(`[data-parameter-row="${index}"]`);
        if (row) row.hidden ||= !resolveFlowExpression(field.presentation.visibleWhen, {}, values);
    });
    updateFlowPresentationGroups(root);
}

export function updateFlowPresentationGroups(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.flow-parameter-group').forEach(group => {
        group.hidden = [...group.querySelectorAll<HTMLElement>('[data-parameter-row], [data-slot-row]')].every(row => row.hidden);
    });
    root.querySelectorAll<HTMLElement>('.flow-parameter-more').forEach(group => {
        group.hidden = [...group.querySelectorAll<HTMLElement>('[data-parameter-row], [data-slot-row]')].every(row => row.hidden);
    });
}
