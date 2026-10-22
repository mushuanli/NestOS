import {createOperationLedger} from '../../../../libraries/llm-ui/src/index';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
import {createNativeChatBinding, createNativeChatView, type ImageEditingHost, type ImageAssetMetadata} from '../../../llm-ui-adapter/src/independent';
import '../../../llm-ui-adapter/src/styles/index.css';
async function waitFor(test: () => boolean) {
    for (let i = 0; i < 300; i++) {if (test()) return; await new Promise(resolve => setTimeout(resolve, 30));}
    throw new Error('Independent image flow did not converge');
}
async function checks() {
    const assets = new Map<string, Blob>(), metadata = new Map<string, ImageAssetMetadata>(); let serial = 0;
    const sent: NonNullable<Parameters<ConversationControls['send']>[1]>[] = [];
    let resize: import('@itookit/image-parser').ImageResizePolicy = {mode: 'max-edge', maxEdge: 1024};
    const policyListeners = new Set<() => void>();
    const images: ImageEditingHost = {
        read: async ref => {const blob = assets.get(ref.id); if (!blob) throw new Error('Missing resource'); return blob;},
        upload: async file => {const id = `asset-${++serial}`; assets.set(id, file); return {id, name: file.name, mimeType: file.type};},
        loadMetadata: async ref => metadata.get(ref.id), saveMetadata: async (ref, value) => {metadata.set(ref.id, value);},
        getResize: () => resize, subscribeResize: listener => {policyListeners.add(listener); return () => {policyListeners.delete(listener);};},
    };
    let state: ConversationSnapshot = {title: 'Native', messages: [], requests: [], attachments: ['image'],
        canSend: true, canRespond: false, canInterrupt: false, pending: false, disconnected: false, gap: false};
    const controls: ConversationControls = {read: async () => state, snapshot: () => state, refresh: async () => state,
        send: async (_text, attachments = []) => {sent.push(attachments); return state = {...state, submittedTurnId: 'independent-turn'};},
        respond: async () => state, reconcile: async () => state, interrupt: async () => state, close: async () => {}};
    const binding = await createNativeChatBinding({conversationId: 'independent', controls, images, operations: createOperationLedger(),
        reconcile: async operationId => ({status: 'unknown', operationId, message: 'Not submitted'})});
    const host = document.querySelector<HTMLElement>('#input')!, view = await createNativeChatView(host, binding, {locale: 'zh-CN'});
    try {
        const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600;
        canvas.getContext('2d')!.fillRect(0, 0, 2400, 1600);
        const file = await new Promise<File>(resolve => canvas.toBlob(blob => resolve(new File([blob!], 'photo.png', {type: 'image/png'}))));
        await view.addFiles([file]); view.setText('Inspect');
        const ref = view.getDraft().attachments[0].file, preserved = metadata.get(ref.id)!;
        const bitmap = await createImageBitmap(assets.get(ref.id)!);
        if (bitmap.width !== 1024 || !assets.has(preserved.original.id)) throw new Error('Preprocessing or original association missing'); bitmap.close();
        resize = {mode: 'original'}; policyListeners.forEach(listener => listener());
        await waitFor(() => view.getDraft().attachments[0].file.id !== ref.id);
        const full = await createImageBitmap(assets.get(view.getDraft().attachments[0].file.id)!);
        if (full.width !== 2400) throw new Error('Policy change did not rebuild from the original'); full.close();
        resize = {mode: 'max-edge', maxEdge: 1024}; policyListeners.forEach(listener => listener());
        await waitFor(() => !host.querySelector<HTMLButtonElement>('[type=submit]')!.disabled);
        const beforeEdit = view.getDraft().attachments[0].revision ?? 0;
        const edit = [...host.querySelectorAll<HTMLButtonElement>('[data-attachment-id] button')].find(button => button.textContent === '编辑')!;
        if (!edit) throw new Error('Image edit action missing'); edit.click();
        await waitFor(() => !!document.querySelector('.image-editor__surface img'));
        document.querySelector<HTMLButtonElement>('[data-tool=rect]')!.click(); await waitFor(() => !!document.querySelector('.image-editor__rect'));
        [...document.querySelectorAll<HTMLButtonElement>('.llm-image-dialog header button')].find(button => button.dataset.action === 'finish-images')!.click();
        await waitFor(() => !document.querySelector('.llm-image-dialog') && view.getDraft().attachments[0].revision === beforeEdit + 1);
        await view.submit();
        if (sent.length !== 1 || !sent[0][0].content.startsWith('data:image/png;base64,') || view.getDraft().attachments.length) throw new Error('Native submit or acceptance cleanup failed');
        return ['independent factory image assembly', 'original metadata association', 'policy change rebuilds original', 'independent crop replacement', 'native image send and acceptance'];
    } finally {await view.destroy(); binding.dispose();}
}
Object.assign(window, {runImageChecks: checks});
