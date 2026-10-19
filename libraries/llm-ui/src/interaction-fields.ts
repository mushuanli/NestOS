import type {InputField} from './contracts';
import {element} from './dom';

export function interactionField(field: InputField): {element: HTMLElement; values(): string[]} {
    const group = element('fieldset'); group.append(element('legend', undefined, field.label));
    if (field.kind === 'text') {
        const input = element(field.multiline && !field.secret ? 'textarea' : 'input');
        if (input instanceof HTMLInputElement) input.type = field.secret ? 'password' : 'text';
        input.setAttribute('aria-label', field.label); input.autocomplete = 'off';
        group.append(input); return {element: group, values: () => [input.value]};
    }
    for (const choice of field.choices) {
        const label = element('label'), input = element('input');
        input.type = field.kind === 'single-choice' ? 'radio' : 'checkbox'; input.name = field.id; input.value = choice.id;
        label.append(input, document.createTextNode(choice.label));
        if (choice.description) label.append(element('small', undefined, choice.description));
        group.append(label);
    }
    const other = field.other ? otherChoice(group, field) : undefined;
    return {element: group, values: () => [...group.querySelectorAll<HTMLInputElement>('input:checked')]
        .map(input => input.dataset.otherChoice ? other!.value : input.value).filter(value => value.trim())};
}
function otherChoice(group: HTMLElement, field: Exclude<InputField, {kind: 'text'}>): HTMLInputElement {
    const label = element('label'), choice = element('input'), text = element('input');
    choice.type = field.kind === 'single-choice' ? 'radio' : 'checkbox'; choice.name = field.id; choice.dataset.otherChoice = 'true';
    text.type = 'text'; text.autocomplete = 'off'; text.setAttribute('aria-label', field.other!);
    text.addEventListener('input', () => {choice.checked = true;});
    label.append(choice, document.createTextNode(field.other!), text); group.append(label); return text;
}
