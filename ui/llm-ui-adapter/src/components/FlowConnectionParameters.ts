import {t} from '@itookit/common';
import type {FlowParameter} from '@itookit/llm-flow/contracts';
import type {FlowConnectionSelection} from './FlowParameterForm';

/** Declarative connection controls write ordinary parameters before submission. */
export function syncConnectionParameters(root: HTMLElement, parameters: FlowParameter[], selection?: FlowConnectionSelection, initial = false): void {
    if (!selection) return;
    parameters.forEach((parameter, index) => {
        const hints = parameter.presentation, name = hints?.connectionToggle ?? hints?.connectionVoices;
        if (!name) return;
        const slot = selection.slots?.findIndex(item => item.name === name) ?? -1;
        const control = root.querySelector<HTMLSelectElement>(`[data-slot-connection="${slot}"]`);
        const row = root.querySelector<HTMLElement>(`[data-parameter-row="${index}"]`);
        const field = root.querySelector<HTMLInputElement>(`[data-parameter="${index}"]`);
        if (!control || !row || !field) return;
        if (hints?.connectionToggle) {
            if (initial && parameter.default !== true) control.value = '';
            field.checked = !!control.value; row.hidden = true;
            control.closest<HTMLElement>('[data-slot-row]')!.hidden = false;
            control.querySelector('option[value=""]')!.textContent = t('connection.slotOff');
        } else {
            const voices = selection.connections.find(item => item.id === control.value)?.voices ?? [];
            updateVoices(field, voices); row.hidden = !control.value || !voices.length;
        }
    });
}

function updateVoices(field: HTMLInputElement, voices: string[]): void {
    const signature = JSON.stringify(voices);
    if (field.dataset.voiceOptions === signature) return;
    const select = document.createElement('select');
    for (const attribute of field.attributes) select.setAttribute(attribute.name, attribute.value);
    select.dataset.voiceOptions = signature;
    select.removeAttribute('data-parameter-enum');
    select.append(new Option('', ''), ...voices.map(voice => new Option(voice, voice)));
    select.value = voices.includes(field.value) ? field.value : '';
    field.replaceWith(select);
}
