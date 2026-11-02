// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import type {ChatView} from '@itookit/llm-ui';
import type {ChatInputSettings} from '../domain/ports/IChatInputPresenter';
import {chatSelectors, mountChatSettings} from './chat-settings';
import {resolveChatImageResize} from '../components/input/image-processing-session';

function fixture(supported = true) {
    const root = document.createElement('div'), configureInput = vi.fn(), settings: ChatInputSettings = {executionMode: 'chat'};
    const view = {getDraft: () => ({revision: 3, selection: {connectionId: 'saved'}}), configureInput} as unknown as ChatView;
    mountChatSettings(root, () => view, () => settings, vi.fn(), () => supported);
    const details = root.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'));
    const form = root.querySelector('form')!, toggle = root.querySelector<HTMLInputElement>('[name=allowTools]');
    return {settings, configureInput, toggle, submit: () => form.dispatchEvent(new Event('submit', {cancelable: true}))};
}
it('places the permission in settings and preserves unrelated selection', () => {
    expect(chatSelectors([], {}).some(item => item.id === 'executionMode')).toBe(false);
    const f = fixture(); f.toggle!.checked = true; f.submit();
    expect(f.configureInput).toHaveBeenCalledWith({selection: expect.objectContaining({connectionId: 'saved', executionMode: 'agent'})}, 3);
});
it('rechecks the session lock on save', () => {
    const f = fixture(); f.toggle!.checked = true; f.settings.executionModeLocked = true; f.submit();
    expect(f.configureInput.mock.calls[0][0].selection.executionMode).toBeUndefined();
});
it('does not expose local tool permission for Flow or a remote harness', () => {
    const f = fixture(false); expect(f.toggle).toBeNull(); f.submit();
    expect(f.configureInput.mock.calls[0][0].selection.executionMode).toBeUndefined();
});
it('uses 1600 by default and preserves explicit image preferences', () => {
    expect(resolveChatImageResize()).toEqual({mode: 'max-edge', maxEdge: 1600});
    expect(resolveChatImageResize(undefined, {mode: 'max-edge', maxEdge: 1024})).toEqual({mode: 'max-edge', maxEdge: 1024});
    expect(resolveChatImageResize({mode: 'original'})).toEqual({mode: 'original'});
});
