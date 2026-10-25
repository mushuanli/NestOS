import {escapeHTML, randomUUID, t} from '@itookit/common';
import {validateFlowInputGroups, type FlowInputGroup, type FlowParameter, type JsonValue} from '@itookit/llm-flow/contracts';

type ParameterField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const mountedGroups = new WeakMap<HTMLElement, readonly FlowInputGroup[]>();

export function renderFlowInputGroups(parameters: FlowParameter[], groups: readonly FlowInputGroup[]): string {
    return groups.map((group, index) => `<fieldset class="flow-input-group" data-flow-input-group="${escapeHTML(group.name)}">
        <legend>${escapeHTML(group.label || t('flow.launch.chooseSource'))}</legend><div class="flow-input-group__choices">${group.parameters.map(name => {
            const parameter = parameters.find(item => item.name === name);
            return `<label><input type="radio" name="flow-input-source-${index}" value="${escapeHTML(name)}" data-flow-source="${escapeHTML(name)}">
                <span>${escapeHTML(parameter?.label?.trim() || name)}</span></label>`;
        }).join('')}</div><small>${escapeHTML(t('flow.launch.sourceHint'))}</small></fieldset>`).join('');
}

export function bindFlowParameterState(root: HTMLElement, parameters: FlowParameter[], groups: readonly FlowInputGroup[], changed: (values: Record<string, JsonValue>) => void): () => void {
    const events = new AbortController(); mountedGroups.set(root, groups);
    const update = () => {
        applySourceSelection(root, parameters, groups);
        changed(currentFlowValues(root, parameters));
    };
    const edit = (event: Event) => {
        if (!(event.target instanceof HTMLElement)) return;
        const row = event.target.closest<HTMLElement>('[data-parameter-row], [data-flow-input-group], [data-slot-row]');
        row?.querySelectorAll('[aria-invalid]').forEach(field => {field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby');});
        row?.querySelectorAll('.flow-parameter-field__error').forEach(field => field.remove());
        root.querySelector('[data-form-error]')?.replaceChildren(); update();
    };
    root.addEventListener('input', edit, {signal: events.signal}); root.addEventListener('change', edit, {signal: events.signal});
    update(); return () => {events.abort(); mountedGroups.delete(root);};
}

function applySourceSelection(root: HTMLElement, parameters: FlowParameter[], groups: readonly FlowInputGroup[]): void {
    const selections = selectedSources(root);
    parameters.forEach((parameter, index) => {
        const row = root.querySelector<HTMLElement>(`[data-parameter-row="${index}"]`);
        if (!row) return;
        const group = groups.find(item => item.parameters.includes(parameter.name)), selected = group && selections.get(group.name);
        row.hidden = !!selected && selected !== parameter.name;
        const required = !!parameter.required || selected === parameter.name;
        row.querySelector('[data-parameter-requirement]')!.textContent = t(required ? 'flow.parameters.required' : 'flow.parameters.optional');
        row.querySelector('[data-parameter]')?.setAttribute('aria-required', String(required));
    });
}

function selectedSources(root: HTMLElement): Map<string, string> {
    return new Map([...root.querySelectorAll<HTMLElement>('[data-flow-input-group]')].map(group =>
        [group.dataset.flowInputGroup!, group.querySelector<HTMLInputElement>('[data-flow-source]:checked')?.value ?? '']));
}

function selectedParameters(root: HTMLElement, parameters: FlowParameter[]): Array<{parameter: FlowParameter; index: number}> {
    const groups = mountedGroups.get(root) ?? [], selections = selectedSources(root);
    for (const group of groups) if (!selections.get(group.name)) {
        const field = [...root.querySelectorAll<HTMLElement>('[data-flow-input-group]')].find(item => item.dataset.flowInputGroup === group.name)!;
        throw fieldFailure(field.querySelector<HTMLElement>('input')!, t('flow.launch.sourceRequired', {name: group.label || group.name}));
    }
    return parameters.flatMap((parameter, index) => {
        const group = groups.find(item => item.parameters.includes(parameter.name));
        return group && selections.get(group.name) !== parameter.name ? [] : [{parameter: {...parameter, required: !!group || parameter.required}, index}];
    });
}

export function readSelectedFlowParameters(root: HTMLElement, parameters: FlowParameter[], read: (root: HTMLElement, parameter: FlowParameter) => Record<string, JsonValue>): Record<string, JsonValue> {
    const entries = selectedParameters(root, parameters).map(({parameter, index}) => {
        const field = root.querySelector<ParameterField>(`[data-parameter="${index}"]`)!, copy = field.cloneNode(true) as ParameterField;
        copy.dataset.parameter = '0'; copy.value = field.value;
        if (copy instanceof HTMLInputElement && field instanceof HTMLInputElement) copy.checked = field.checked;
        const container = document.createElement('div'); container.append(copy);
        try {return read(container, parameter);}
        catch (error) {throw fieldFailure(field, error instanceof Error ? error.message : String(error));}
    });
    const values = Object.assign({}, ...entries), groups = mountedGroups.get(root) ?? [];
    const diagnostics = validateFlowInputGroups(parameters, [...groups], values);
    if (diagnostics.length) {
        const selected = root.querySelector<HTMLElement>('[data-flow-source]:checked') ?? root.querySelector<HTMLElement>('[data-flow-source]')!;
        throw fieldFailure(selected, diagnostics[0].message);
    }
    return values;
}

export function currentFlowValues(root: HTMLElement, parameters: FlowParameter[]): Record<string, JsonValue> {
    const selected = selectedSources(root), groups = mountedGroups.get(root) ?? [];
    return Object.fromEntries(parameters.flatMap((parameter, index) => {
        const group = groups.find(item => item.parameters.includes(parameter.name));
        if (group && selected.get(group.name) && selected.get(group.name) !== parameter.name) return [];
        const field = root.querySelector<ParameterField>(`[data-parameter="${index}"]`);
        if (!field) return [];
        const value = currentFieldValue(field, parameter);
        return value === undefined ? [] : [[parameter.name, value]];
    }));
}

function currentFieldValue(field: ParameterField, parameter: FlowParameter): JsonValue | undefined {
    if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked;
    if (!field.value.trim()) return;
    if (parameter.type === 'json' || field.hasAttribute('data-parameter-enum')) {
        try {return JSON.parse(field.value) as JsonValue;} catch {return;}
    }
    if (parameter.type === 'number') return Number.isFinite(Number(field.value)) ? Number(field.value) : undefined;
    return field.value;
}

export function fieldFailure(field: HTMLElement, message: string): Error {
    return Object.assign(new Error(message), {flowField: field});
}

export function showFlowFieldError(root: HTMLElement, error: unknown): void {
    let field = (error as {flowField?: HTMLElement} | undefined)?.flowField;
    if (!field || !root.contains(field)) return;
    const row = field.closest<HTMLElement>('[data-parameter-row], [data-flow-input-group], [data-slot-row]') ?? field.parentElement!;
    const details = field.closest('details'); if (details) details.open = true;
    if (field.hidden) field = row.querySelector<HTMLElement>('[data-image-picker], [data-file-picker]') ?? field;
    field.setAttribute('aria-invalid', 'true');
    let notice = row.querySelector<HTMLElement>('.flow-parameter-field__error');
    if (!notice) {notice = document.createElement('small'); notice.className = 'flow-parameter-field__error'; notice.id = 'flow-field-error-' + randomUUID(); row.append(notice);}
    notice.textContent = error instanceof Error ? error.message : String(error); field.setAttribute('aria-describedby', notice.id);
    field.focus(); field.scrollIntoView?.({block: 'nearest'});
}
