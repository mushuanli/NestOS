import type {ConversationSnapshot} from '../contracts';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ConversationInformation} from './ConversationInformation';

afterEach(() => document.body.replaceChildren());
const state: ConversationSnapshot = {title: 'Native', messages: [], requests: [], pending: false, gap: false, disconnected: false,
    canSend: true, canInterrupt: false, canRespond: false, supportsMetrics: true};
it('loads metrics only on opening or explicit refresh, keeps failure local and ignores a closed dialog response', async () => {
    Object.defineProperties(HTMLDialogElement.prototype, {
        showModal: {configurable: true, value(this: HTMLDialogElement) {this.open = true;}},
        close: {configurable: true, value(this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event('close'));}},
    });
    const read = vi.fn(async () => ({...state, metrics: {observedAt: 1793440000000, contextWindow: {usedTokens: 1000, limitTokens: 200000}}}));
    const information = new ConversationInformation(document.body, read); information.setSnapshot(state);
    expect(read).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-action=conversation-information]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-session-info-metrics]')!.textContent).toContain('1,000 / 200,000'));
    expect(read).toHaveBeenCalledOnce();
    read.mockRejectedValue(Object.assign(new Error('private native response'), {code: 'ETIMEDOUT'}));
    document.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-session-info-metrics]')!.textContent).toContain('ETIMEDOUT'));
    expect(document.querySelector('[data-session-info-metrics]')!.textContent).not.toContain('private native response');
    expect(state.canSend).toBe(true);
    let finish!: (value: Awaited<ReturnType<typeof read>>) => void;
    read.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    document.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!.click();
    information.destroy(); finish({...state, metrics: {observedAt: 1793440000000, contextWindow: {usedTokens: 5000, limitTokens: 200000}}});
    await Promise.resolve(); expect(document.querySelector('dialog')).toBeNull();
});
