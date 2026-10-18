import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
import {ConversationComposerStore} from '../../../../backend/app-core/src/projects/conversation-composer-store';
import {RemoteConversationEditor} from '../../../llm-ui-adapter/src/shell/RemoteConversationEditor';
import '../../../llm-ui-adapter/src/styles/index.css';
const assert = (value: unknown, text: string) => {if (!value) throw new Error(text);};
async function waitFor(test: () => boolean) {
    for (let i = 0; i < 300; i++) {if (test()) return; await new Promise(resolve => setTimeout(resolve, 30));}
    throw new Error('Conversation image state did not converge');
}
async function photo(): Promise<File> {
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 2400, 1600);
    return new Promise(resolve => canvas.toBlob(blob => resolve(new File([blob!], 'camera.png', {type: 'image/png'}))));
}
async function checks() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const store = new ConversationComposerStore(fs, 'project', 'stable-conversation-uuid', true, () => {});
    let snapshot: ConversationSnapshot = {sessionId: 'native', title: 'Fixture', messages: [], requests: [], attachments: ['image'],
        canSend: true, canRespond: false, canInterrupt: false, pending: false, disconnected: false, gap: false};
    const sent: NonNullable<Parameters<ConversationControls['send']>[1]>[] = [];
    const controls = (): ConversationControls => ({snapshot: () => snapshot, read: async () => snapshot, poll: async () => snapshot,
        send: async (_text, attachments = [], _selection, id) => {sent.push(attachments); snapshot = {...snapshot, submittedTurnId: 'accepted-turn', submission: {id: id!, status: 'accepted', turnId: 'accepted-turn'}, draft: ''}; return snapshot;},
        respond: async () => snapshot, interrupt: async () => snapshot, reconcile: async () => snapshot, close: async () => {},
        saveDraft: async text => {snapshot = {...snapshot, draft: text};},
        readComposerDraft: () => store.readComposerDraft(), saveComposerDraft: store.saveComposerDraft.bind(store),
        putComposerAsset: store.putComposerAsset.bind(store), readComposerAsset: store.readComposerAsset.bind(store)});
    const host = document.querySelector<HTMLElement>('#input')!, first = new RemoteConversationEditor(host, controls(), {});
    let editor = first;
    try {
        await first.init(host);
        const input = host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
        input.value = 'Inspect'; input.dispatchEvent(new Event('input', {bubbles: true}));
        const data = new DataTransfer(); data.items.add(await photo()); input.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true}));
        await waitFor(() => !!host.querySelector('.llm-input__image-edit') && !host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.disabled);
        host.querySelector<HTMLButtonElement>('.llm-input__image-edit')!.click();
        await waitFor(() => !!document.querySelector('.image-editor__surface img'));
        document.querySelector<HTMLButtonElement>('[data-tool=rect]')!.click(); await waitFor(() => !!document.querySelector('.image-editor__rect'));
        document.querySelector<HTMLButtonElement>('[data-action=apply-image]')!.click();
        await waitFor(() => !document.querySelector<HTMLButtonElement>('[data-action=apply-image]')!.disabled && !document.querySelector('.image-editor__rect'));
        document.querySelector<HTMLButtonElement>('[data-tool=rect]')!.click(); await waitFor(() => !!document.querySelector('.image-editor__rect'));
        [...document.querySelectorAll<HTMLButtonElement>('.llm-image-dialog header button')].find(button => button.dataset.action === 'finish-images')!.click();
        await waitFor(() => !document.querySelector('.llm-image-dialog')); await first.flushPendingSave();
        const saved = JSON.parse((await store.readComposerDraft()).data), originalId = saved.files[0].image.original.id;
        assert(saved.files[0].image.spec.version === 2 && saved.files[0].image.spec.steps.length === 2, 'Both crops stored with original');
        const original = await createImageBitmap(new Blob([await store.readComposerAsset(originalId)]));
        assert(original.width === 2400, 'Full original remains in host storage'); original.close();
        await first.destroy(); editor = new RemoteConversationEditor(host, controls(), {}); await editor.init(host);
        assert(host.querySelectorAll('.llm-input__attachment-tag').length === 1, 'Attachment restored on reopen');
        assert(host.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!.value === 'Inspect', 'Text restored on reopen');
        host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!.click(); await waitFor(() => sent.length === 1);
        await waitFor(() => !host.querySelectorAll('.llm-input__attachment-tag').length);
        await editor.flushPendingSave();
        assert(sent[0][0].content.startsWith('data:image/png;base64,'), 'Harness receives image bytes');
        assert(!('image' in sent[0][0]) && !('spec' in sent[0][0]), 'Host metadata stays outside harness');
        const cleared = JSON.parse((await store.readComposerDraft()).data);
        assert(cleared.config.text === '' && !cleared.files.length, 'Accepted draft stays cleared after reopen');
        return ['remote crop and original persistence', 'remote draft reopen', 'harness image submission', 'accepted draft persistence'];
    } finally {await editor.destroy(); await manager.dispose();}
}
Object.assign(window, {runImageChecks: checks});
