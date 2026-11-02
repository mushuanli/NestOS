import type {ConversationSnapshot} from '../contracts';
// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@itookit/common';

import {nativeWriterLockText} from './native-writer-lock';
import {NativeInstructionQueuePanel} from '../components/NativeInstructionQueuePanel';
import {ConversationInformation} from './ConversationInformation';

afterEach(() => document.body.replaceChildren());

it('shows verified owner identity and labels the unavailable acquisition time explicitly', () => {
    const text = nativeWriterLockText({status: 'held', checkedAt: 1793428000000, acquiredAt: null,
        lockFileModifiedAt: 1793427000000, owner: {pid: 42, uid: 1000, processStartedAt: 1793426000000}});
    expect(text).toContain('PID: 42 · UID: 1000');
    expect(text).toContain(t('harness.writerLock.acquiredAt', {time: t('harness.writerLock.unknownTime')}));
    expect(text).toContain(t('harness.writerLock.processStartedAt', {time: new Date(1793426000000).toLocaleString('zh-CN', {hour12: false})}));
    expect(nativeWriterLockText(undefined)).toBe(t('harness.writerLock.unavailable'));
});

it('refreshes current lock evidence without changing or retrying the failed queue item', () => {
    Object.defineProperties(HTMLDialogElement.prototype, {
        showModal: {configurable: true, value(this: HTMLDialogElement) {this.open = true;}},
        close: {configurable: true, value(this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event('close'));}},
    });
    const host = document.createElement('section'); document.body.append(host);
    const state: ConversationSnapshot = {title: '', messages: [], requests: [], canSend: false, canInterrupt: false,
        canRespond: false, pending: false, disconnected: false, gap: false,
        instructionQueue: {revision: 7, paused: true, acceptedIds: ['op'],
        items: [{id: 'op', text: 'Input', files: [], createdAt: 1793426000000, state: 'failed', error: 'HARNESS_SESSION_BUSY'}]},
        writerLock: {status: 'held', checkedAt: 1793428000000, owner: {pid: 42, uid: 1000}}};
    const editInstructionQueue = vi.fn(), panel = new NativeInstructionQueuePanel(host, {read: vi.fn(), editInstructionQueue}, vi.fn());
    const information = new ConversationInformation(document.body);
    try {
        panel.update(state);
        information.setSnapshot(state);
        document.querySelector<HTMLButtonElement>('[data-action="conversation-information"]')!.click();
        expect(document.querySelector('[data-native-writer-lock]')?.textContent).toContain('PID: 42');
        information.setSnapshot({...state, writerLock: {status: 'not-held', checkedAt: 1793428015000}});
        expect(document.querySelector('[data-native-writer-lock]')?.textContent).toContain(t('harness.writerLock.not-held'));
        expect(document.querySelector('[data-native-writer-lock]')?.textContent).not.toContain('PID: 42');
        expect(host.querySelector('[data-action="retry"]')).not.toBeNull();
        expect(editInstructionQueue).not.toHaveBeenCalled();
        expect(state.instructionQueue?.items[0].state).toBe('failed');
    } finally {information.destroy(); panel.destroy();}
});
