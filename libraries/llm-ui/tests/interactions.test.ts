import {afterEach, expect, it, vi} from 'vitest';
import {createInteractionCard} from '../src/interactions';

afterEach(() => document.body.replaceChildren());
it('renders descriptions, multiple selections, custom answers and secret text without mixing fields', async () => {
    const submit = vi.fn(async () => {});
    const card = createInteractionCard({id: 'request', revision: 0, state: 'pending', kind: 'input', title: 'Questions', fields: [
        {id: 'features', label: 'Features', kind: 'multi-choice', required: true, min: 1, other: 'Other', choices: [
            {id: 'A', label: 'A', description: 'First feature'}, {id: 'B', label: 'B', description: 'Second feature'}]},
        {id: 'password', label: 'Token', kind: 'text', secret: true, required: true},
    ]}, submit); document.body.append(card.element);
    expect(card.element.textContent).toContain('First feature');
    const choices = card.element.querySelectorAll<HTMLInputElement>('input[type=checkbox]'); choices[0].checked = choices[1].checked = true;
    const token = card.element.querySelector<HTMLInputElement>('input[type=password]')!; token.value = 'private';
    card.element.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith({kind: 'input', values: {features: ['A', 'B'], password: 'private'}}));
    expect(card.element.innerHTML).not.toContain('private'); card.destroy();
});
it('requires an answer, validates selection limits and preserves input through disable/enable', async () => {
    const submit = vi.fn(async () => {}), card = createInteractionCard({id: 'q', revision: 0, state: 'pending', kind: 'input', title: 'Q',
        fields: [{id: 'q', label: 'Q', kind: 'single-choice', required: true, other: 'Other', choices: [{id: 'A', label: 'A'}]}]}, submit);
    document.body.append(card.element); const form = card.element.querySelector('form')!;
    form.dispatchEvent(new Event('submit', {cancelable: true})); expect(submit).not.toHaveBeenCalled();
    const custom = card.element.querySelector<HTMLInputElement>('input[type=text]')!; custom.value = 'Custom'; custom.dispatchEvent(new Event('input'));
    card.setPending(true); expect(custom.disabled).toBe(true); card.setPending(false); expect(custom.value).toBe('Custom');
    form.dispatchEvent(new Event('submit', {cancelable: true}));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith({kind: 'input', values: {q: 'Custom'}})); card.destroy();
});
it('keeps unsupported interactions visible without response controls', () => {
    const card = createInteractionCard({id: 'u', revision: 0, kind: 'unsupported', state: 'pending', title: 'Unknown'}, vi.fn(), {locale: 'en'});
    expect(card.element.textContent).toContain('unsupported'); expect(card.element.querySelector('button')).toBeNull(); card.destroy();
});
