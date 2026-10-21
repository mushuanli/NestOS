// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { InteractionPanel } from '../../llm-ui-adapter/src/components/input/InteractionPanel';
import { inputInteraction } from '../../llm-ui-adapter/src/shell/input-interaction';
import { InvocationPanel } from '../../llm-ui-adapter/src/flows/InvocationPanel';

const questions = [{ question: 'Choose <script>bad()</script>', header: 'Place', options: [
    { label: 'Local', description: 'Keep <b>data</b> here' }, { label: 'Remote', description: 'Use another host' },
] }, { question: 'Choose features', header: 'Features', multiSelect: true, options: [
    { label: 'Read', description: 'Read only' }, { label: 'Write', description: 'Allow edits' },
] }];
const request = { id: 'ask', kind: 'input' as const, prompt: questions[0].question, payload: { questions, options: null } };
const panels: InteractionPanel[] = [];
afterEach(() => { panels.splice(0).forEach(panel => panel.clear()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup() {
    const root = document.createElement('div'); document.body.append(root);
    const panel = new InteractionPanel(root); panels.push(panel);
    const respond = vi.fn(async () => {});
    panel.show(inputInteraction(request, 1), respond);
    return { root, panel, respond, send: () => root.querySelector<HTMLFormElement>('form')!.requestSubmit() };
}
function select(root: HTMLElement): void {
    root.querySelector<HTMLInputElement>('input[value="Local"]')!.click();
    root.querySelector<HTMLInputElement>('input[value="Read"]')!.click();
    root.querySelector<HTMLInputElement>('input[value="Write"]')!.click();
}

it('shows all questions, choice descriptions and independent single/multi controls as literal text', () => {
    const { root } = setup();
    expect(root.querySelectorAll('fieldset')).toHaveLength(2);
    expect(root.querySelector('script')).toBeNull(); expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('Keep <b>data</b> here');
    expect(root.querySelector<HTMLInputElement>('input[value="Local"]')?.type).toBe('radio');
    expect(root.querySelector<HTMLInputElement>('input[value="Read"]')?.type).toBe('checkbox');
    expect(root.querySelector('pre')).toBeNull();
});

it('requires every answer, keeps an in-progress selection on replay and submits all answers once', async () => {
    const { root, panel, respond, send } = setup();
    send(); expect(respond).not.toHaveBeenCalled(); expect(root.querySelector('.llm-chat__error')?.textContent).not.toBe('');
    select(root); panel.show(inputInteraction(request, 1), respond);
    expect(root.querySelectorAll('input:checked')).toHaveLength(3);
    send(); send();
    await vi.waitFor(() => expect(root.querySelector('.llm-input__interaction')).toBeNull());
    expect(respond).toHaveBeenCalledTimes(1);
    expect(JSON.parse(respond.mock.calls[0][0])).toEqual({ answers: {
        [questions[0].question]: 'Local', 'Choose features': '["Read","Write"]',
    } });
});

it('retains selections after failed submission and logs only correlation metadata', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, respond, send } = setup(); select(root);
    respond.mockRejectedValueOnce(new Error('Connection unavailable'));
    send(); await vi.waitFor(() => expect(root.textContent).toContain('Connection unavailable'));
    expect(root.querySelectorAll('input:checked')).toHaveLength(3);
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Connection unavailable');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Choose features');
    send(); await vi.waitFor(() => expect(root.querySelector('.llm-input__interaction')).toBeNull());
    expect(debug).toHaveBeenCalledWith('[Interaction]', expect.objectContaining({ outcome: 'success', requestId: 'ask' }));
});

it('allows a custom answer while retaining the other question selection', async () => {
    const { root, respond, send } = setup(); select(root);
    const custom = root.querySelector<HTMLInputElement>('fieldset input[type="text"]')!;
    custom.value = 'Another destination'; custom.dispatchEvent(new Event('input'));
    send(); await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(JSON.parse(respond.mock.calls[0][0]).answers[questions[0].question]).toBe('Another destination');
});

it('does not let a late successful answer clear a newly attached interaction', async () => {
    const { root, panel, respond, send } = setup(); let finish!: () => void;
    respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    select(root); send();
    panel.show(inputInteraction({ ...request, id: 'next' }, 2), async () => {});
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.llm-input__interaction')?.getAttribute('data-request-id')).toBe('next');
    expect(root.querySelector<HTMLInputElement>('input[value="Local"]')!.disabled).toBe(false);
});

it('uses the same question projection for Flow invocation interactions', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const respond = vi.fn(async () => {});
    const panel = (InvocationPanel.prototype as any).showInteraction.call({}, root, request, 'invocation/ask', respond);
    panels.push(panel); select(root); root.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(JSON.parse(respond.mock.calls[0][0]).answers['Choose features']).toBe('["Read","Write"]');
});
