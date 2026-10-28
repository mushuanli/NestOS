import {applyFlowParameterVisibility} from './FlowParameterPresentation';
import {escapeHTML, randomUUID, t} from '@itookit/common';
import {flowInputPresent, validateFlowInputGroups, type FlowInputGroup, type FlowParameter, type JsonValue} from '@itookit/llm-flow/contracts';

type ParameterField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const mountedGroups = new WeakMap<HTMLElement, readonly FlowInputGroup[]>();

export function renderFlowInputGroups(parameters: FlowParameter[], groups: readonly FlowInputGroup[]): string {
    return groups.map((group, index) => {
        const present = group.parameters.filter(name => flowInputPresent(parameters.find(field => field.name === name)?.default));
        const tabPrefix = 'flow-input-' + randomUUID();
        const active = present[0] ?? group.parameters[0];
        const choices = group.parameters.map((name, fieldIndex) => {
            const parameter = parameters.find(item => item.name === name), label = escapeHTML(parameter?.label?.trim() || name);
            if (group.mode === 'anyOf') return `<button type="button" role="tab" id="${tabPrefix}-${fieldIndex}" data-flow-tab="${escapeHTML(name)}"
                aria-selected="${name === active}" tabindex="${name === active ? 0 : -1}" aria-controls="${tabPrefix}-${fieldIndex}-panel">${label}
                <small data-flow-filled ${present.includes(name) ? '' : 'hidden'}>${escapeHTML(t('flow.launch.sourceFilled'))}</small></button>`;
            return `<label><input type="radio" name="flow-input-source-${index}" value="${escapeHTML(name)}" data-flow-source="${escapeHTML(name)}"
                ${present.length === 1 && present[0] === name ? 'checked' : ''}><span>${label}</span></label>`;
        }).join(group.mode === 'anyOf' ? '' : `<span class="flow-input-group__or">${escapeHTML(t('flow.launch.sourceOr'))}</span>`);
        return `<fieldset class="flow-input-group" data-flow-input-group="${escapeHTML(group.name)}">
            <legend>${escapeHTML(group.label || t('flow.launch.chooseSource'))} · ${escapeHTML(t(group.mode === 'anyOf' ? 'flow.launch.sourceAnyOf' : 'flow.launch.sourceOneOf'))}</legend>
            <div class="flow-input-group__choices" ${group.mode === 'anyOf' ? 'role="tablist"' : ''}>${choices}</div><small>${escapeHTML(t(group.mode === 'anyOf' ? 'flow.launch.sourceAnyHint' : 'flow.launch.sourceHint'))}</small></fieldset>`;
    }).join('');
}

export function bindFlowParameterState(root: HTMLElement, parameters: FlowParameter[], groups: readonly FlowInputGroup[], changed: (values: Record<string, JsonValue>) => void): () => void {
    const events = new AbortController(); mountedGroups.set(root, groups);
    const update = () => {
        applySourceSelection(root, parameters, groups);
        const values = currentFlowValues(root, parameters);
        applyFlowParameterVisibility(root, parameters, values); changed(values);
    };
    const edit = (event: Event) => {
        if (!(event.target instanceof HTMLElement)) return;
        const row = event.target.closest<HTMLElement>('[data-parameter-row], [data-flow-input-group], [data-slot-row]');
        row?.querySelectorAll('[aria-invalid]').forEach(field => {field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby');});
        row?.querySelectorAll('.flow-parameter-field__error').forEach(field => field.remove());
        root.querySelector('[data-form-error]')?.replaceChildren(); update();
    };
    bindSourceTabs(root, events.signal, update);
    root.addEventListener('input', edit, {signal: events.signal}); root.addEventListener('change', edit, {signal: events.signal});
    update(); return () => {events.abort(); mountedGroups.delete(root);};
}

function applySourceSelection(root: HTMLElement, parameters: FlowParameter[], groups: readonly FlowInputGroup[]): void {
    const selections = selectedSources(root);
    parameters.forEach((parameter, index) => {
        const row = root.querySelector<HTMLElement>(`[data-parameter-row="${index}"]`);
        if (!row) return;
        const group = groups.find(item => item.mode === 'oneOf' && item.parameters.includes(parameter.name)), selected = group && selections.get(group.name);
        row.hidden = !!selected && selected !== parameter.name;
        const tab = [...root.querySelectorAll<HTMLButtonElement>('[data-flow-tab]')].find(item => item.dataset.flowTab === parameter.name);
        if (tab) {
            row.hidden = tab.getAttribute('aria-selected') !== 'true'; row.id = tab.getAttribute('aria-controls')!;
            row.setAttribute('role', 'tabpanel'); row.setAttribute('aria-labelledby', tab.id);
            const field = row.querySelector<ParameterField>('[data-parameter]');
            tab.querySelector<HTMLElement>('[data-flow-filled]')!.hidden = !flowInputPresent(field && currentFieldValue(field, parameter));
        }
        const required = !!parameter.required || selected === parameter.name;
        row.querySelector('[data-parameter-requirement]')!.textContent = t(required ? 'flow.parameters.required' : 'flow.parameters.optional');
        row.querySelector('[data-parameter]')?.setAttribute('aria-required', String(required));
    });
}

function bindSourceTabs(root: HTMLElement, signal: AbortSignal, changed: () => void): void {
    root.addEventListener('click', event => {
        const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-flow-tab]');
        if (tab) {activateSourceTab(tab); changed();}
    }, {signal});
    root.addEventListener('keydown', event => {
        const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-flow-tab]');
        if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...tab.parentElement!.querySelectorAll<HTMLButtonElement>('[data-flow-tab]')], index = tabs.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); activateSourceTab(tabs[next]); changed(); tabs[next].focus();
    }, {signal});
}
function activateSourceTab(tab: HTMLButtonElement): void {
    tab.parentElement!.querySelectorAll<HTMLButtonElement>('[data-flow-tab]').forEach(item => {
        const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
    });
}

function selectedSources(root: HTMLElement): Map<string, string> {
    return new Map([...root.querySelectorAll<HTMLElement>('[data-flow-input-group]')].map(group =>
        [group.dataset.flowInputGroup!, group.querySelector<HTMLInputElement>('[data-flow-source]:checked')?.value ?? '']));
}

function selectedParameters(root: HTMLElement, parameters: FlowParameter[]): Array<{parameter: FlowParameter; index: number}> {
    const groups = mountedGroups.get(root) ?? [], selections = selectedSources(root);
    for (const group of groups) if (group.mode === 'oneOf' && !selections.get(group.name)) {
        const field = [...root.querySelectorAll<HTMLElement>('[data-flow-input-group]')].find(item => item.dataset.flowInputGroup === group.name)!;
        throw fieldFailure(field.querySelector<HTMLElement>('input')!, t('flow.launch.sourceRequired', {name: group.label || group.name}));
    }
    return parameters.flatMap((parameter, index) => {
        const group = groups.find(item => item.mode === 'oneOf' && item.parameters.includes(parameter.name));
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
        const selected = root.querySelector<HTMLElement>('[data-flow-source]:checked') ?? root.querySelector<HTMLElement>('[data-flow-source]')
            ?? root.querySelector<HTMLElement>('[data-parameter]')!;
        throw fieldFailure(selected, diagnostics[0].message);
    }
    return values;
}

export function currentFlowValues(root: HTMLElement, parameters: FlowParameter[]): Record<string, JsonValue> {
    const selected = selectedSources(root), groups = mountedGroups.get(root) ?? [];
    return Object.fromEntries(parameters.flatMap((parameter, index) => {
        const group = groups.find(item => item.mode === 'oneOf' && item.parameters.includes(parameter.name));
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
    if (row.hidden && row.getAttribute('role') === 'tabpanel') root.querySelector<HTMLButtonElement>(`[id="${row.getAttribute('aria-labelledby')}"]`)?.click();
    row.hidden = false; row.closest<HTMLElement>('.flow-parameter-group')?.removeAttribute('hidden');
    const details = field.closest('details'); if (details) {details.hidden = false; details.open = true;}
    if (field.hidden) field = row.querySelector<HTMLElement>('[data-image-picker], [data-file-picker]') ?? field;
    field.setAttribute('aria-invalid', 'true');
    let notice = row.querySelector<HTMLElement>('.flow-parameter-field__error');
    if (!notice) {notice = document.createElement('small'); notice.className = 'flow-parameter-field__error'; notice.id = 'flow-field-error-' + randomUUID(); row.append(notice);}
    notice.textContent = error instanceof Error ? error.message : String(error); field.setAttribute('aria-describedby', notice.id);
    field.focus(); field.scrollIntoView?.({block: 'nearest'});
}
