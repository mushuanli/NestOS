// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {renderConversationRequests, clearConversationRequests} from '../../llm-ui-adapter/src/shell/remote-interactions';
import type {ConversationRequest} from '@itookit/ui-common';
it('renders a restored native dialog, keeps edits during observations, and replies with multiple selected values', async () => {
    const host = document.createElement('section'), respond = vi.fn(async () => {}); document.body.append(host);
    const request: ConversationRequest = {id: 'q', kind: 'input', detail: '', questions: [
        {id: 'q', question: 'Features', multiSelect: true, options: [{label: 'A', description: 'First'}, {label: 'B'}]},
        {id: 'secret', question: 'Secret', isSecret: true},
    ]};
    try {
        renderConversationRequests(host, [request], respond, true);
        const choices = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]'); choices[0].checked = choices[1].checked = true;
        const secret = host.querySelector<HTMLInputElement>('input[type=password]')!; secret.value = 'private';
        renderConversationRequests(host, structuredClone([request]), respond, false); expect(secret.disabled).toBe(true);
        renderConversationRequests(host, structuredClone([request]), respond, true); expect(host.querySelector('input[type=password]')).toBe(secret);
        host.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
        await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('q', {answers: {q: {answers: ['A', 'B']}, secret: {answers: ['private']}}}));
        expect(host.textContent).toContain('First');
        renderConversationRequests(host, [], respond, false); expect(host.childElementCount).toBe(0);
    } finally {clearConversationRequests(host); host.remove();}
});
