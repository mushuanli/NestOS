// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ChatInput, type ChatInputOptions} from '../../llm-ui-adapter/src/components/input/ChatInputView';

let input: ChatInput | undefined;
afterEach(() => {input?.destroy(); input = undefined; document.body.replaceChildren(); vi.unstubAllGlobals();});
function setup() {
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    const host = document.createElement('div'); document.body.append(host);
    const changed = vi.fn();
    const options: ChatInputOptions = {attachments: false, initialAgents: [{id: 'remote:codex', name: 'Codex'}],
        onSend: async () => {}, onStop() {}, onDraftChange: changed};
    input = new ChatInput(host, options);
    const paste = () => {
        const event = new Event('paste', {bubbles: true});
        Object.defineProperty(event, 'clipboardData', {value: {items: [{kind: 'file', getAsFile: () => new File(['image'], 'photo.png', {type: 'image/png'})}]}});
        host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.dispatchEvent(event);
    };
    return {host, options, changed, paste};
}
it('updates paste and drop capabilities in both directions without duplicating handlers', () => {
    const f = setup(); f.paste(); expect(f.changed).not.toHaveBeenCalled();
    input!.adopt({...f.options, attachments: true}); input!.adopt({...f.options, attachments: true});
    f.paste(); expect(f.changed.mock.calls.at(-1)![1]).toHaveLength(1);
    const drop = new Event('drop', {bubbles: true});
    Object.defineProperty(drop, 'dataTransfer', {value: {files: [new File(['text'], 'note.txt')]}});
    f.host.querySelector('.llm-input__field-wrapper')!.dispatchEvent(drop);
    expect(f.changed.mock.calls.at(-1)![1]).toHaveLength(2);
    const count = f.changed.mock.calls.length;
    input!.adopt(f.options); f.paste(); f.host.querySelector('.llm-input__field-wrapper')!.dispatchEvent(drop);
    expect(f.changed).toHaveBeenCalledTimes(count);
});
it('restores the previous capability callbacks after a failed binding without replacing the textarea', () => {
    const f = setup(), textarea = f.host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!, rollback = input!.checkpoint();
    input!.setConfig({text: 'Unsent text'}); textarea.focus(); textarea.setSelectionRange(3, 3);
    input!.adopt({...f.options, attachments: true, onDraftChange: vi.fn()}); rollback();
    expect(f.host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')).toBe(textarea); expect(textarea.value).toBe('Unsent text');
    expect(document.activeElement).toBe(textarea); expect(textarea.selectionStart).toBe(3);
    f.paste(); expect(f.changed).not.toHaveBeenCalled();
});
