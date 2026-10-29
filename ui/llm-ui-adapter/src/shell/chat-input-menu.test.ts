// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createChatView, createOperationLedger, type ChatView, type ConversationSnapshot} from '@itookit/llm-ui';
import {mountChatInputMenu} from './chat-input-menu';
import {chatAttachmentMenu} from './chat-attachment-menu';
import {prepareImageChatOptions} from '../independent/image-chat-view';
import {presentChatButton} from '../independent/button-presentation';
const views: ChatView[] = [];
afterEach(async () => {for (const view of views.splice(0)) await view.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function fixture() {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(callback, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    const snapshot: ConversationSnapshot = {conversationId: 'chat', viewId: 'view', revision: 0, title: 'Chat', messages: [], interactions: [],
        loading: false, execution: 'idle', connection: 'online', hasEarlier: false, allowed: ['send']};
    const root = document.createElement('div'); document.body.append(root);
    const send = vi.fn(async (_input, context) => ({status: 'accepted' as const, operationId: context.operationId}));
    const view = await createChatView(root, prepareImageChatOptions({source: {getSnapshot: () => snapshot, subscribe: () => () => {}}, operations: createOperationLedger(),
        upload: async file => ({id: 'file', name: file.name}), attachmentMenu: chatAttachmentMenu(true), actions: {send, reconcile: async operationId => ({status: 'unknown', operationId, message: 'Pending'})},
        mountComposerMenu: (host, context) => mountChatInputMenu(host, {view: context.view,
            settings: () => ({webSearchEnabled: context.view.getDraft().selection?.webSearchEnabled !== 'false'}), prompts: () => [{name: 'Preset', prompt: ' preset'}],
            agentId: () => 'assistant', available: () => true, report: error => {throw error;}, hasFiles: true})}));
    views.push(view); return {root, view, send};
}
it('restores web search, preset insertion and help without sending or replacing the draft input', async () => {
    const f = await fixture(), input = f.root.querySelector<HTMLTextAreaElement>('.llm-chat__input')!;
    f.view.setText('Keep'); input.setSelectionRange(4, 4);
    f.root.querySelector<HTMLButtonElement>('[data-input-action=websearch]')!.click();
    expect(f.view.getDraft().selection?.webSearchEnabled).toBe('false');
    expect(f.root.querySelector('[data-input-action=websearch]')!.getAttribute('aria-pressed')).toBe('false');
    f.root.querySelector<HTMLButtonElement>('[data-input-action=prompts]')!.click();
    document.querySelector<HTMLElement>('.llm-popup--visible .llm-popup__item')!.click();
    expect(f.view.getDraft().text).toBe('Keep preset'); expect(document.activeElement).toBe(input);
    f.root.querySelector<HTMLButtonElement>('[data-input-action=help]')!.click();
    expect(f.root.querySelector<HTMLElement>('.llm-input__help-panel')!.style.display).toBe('block');
    f.root.querySelector<HTMLButtonElement>('.llm-input__help-close')!.click();
    expect(f.root.querySelector<HTMLElement>('.llm-input__help-panel')!.style.display).toBe('none');
    expect(f.view.getDraft().text).toBe('Keep preset'); expect(f.send).not.toHaveBeenCalled();
    expect(f.root.querySelector('.llm-chat__input')).toBe(input);
});
it('restores attachment sources and prevents a late file dialog from uploading into a replacement binding', async () => {
    const f = await fixture(); f.root.querySelector<HTMLButtonElement>('[data-chat-action=attach]')!.click();
    expect([...document.querySelectorAll('.llm-popup--visible .llm-popup__item')].map(node => node.textContent)).toEqual(expect.arrayContaining([
        expect.stringContaining('拍照'), expect.stringContaining('相册'), expect.stringContaining('上传附件'), expect.stringContaining('引用文件')]));
    const camera = [...document.querySelectorAll<HTMLElement>('.llm-popup--visible .llm-popup__item')].find(node => node.textContent!.includes('拍照'))!;
    camera.click(); await vi.waitFor(() => expect(f.root.querySelector('input[type=file]')!.getAttribute('capture')).toBe('environment'));
    const upload = vi.fn(async file => ({id: 'new-file', name: file.name})), snapshot = {conversationId: 'chat', viewId: 'replacement', revision: 1,
        title: 'Chat', messages: [], interactions: [], loading: false, execution: 'idle', connection: 'online', hasEarlier: false, allowed: ['send']} as ConversationSnapshot;
    await f.view.replaceBinding({source: {getSnapshot: () => snapshot, subscribe: () => () => {}}, actions: {send: f.send, reconcile: async operationId => ({status: 'unknown', operationId, message: 'Pending'})}, operations: createOperationLedger(), upload});
    const picker = f.root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(picker, 'files', {value: [new File(['late'], 'late.txt')], configurable: true}); picker.dispatchEvent(new Event('change'));
    await Promise.resolve(); expect(upload).not.toHaveBeenCalled(); expect(f.view.getDraft().attachments).toEqual([]);
    await vi.waitFor(() => expect(f.root.querySelector('.llm-input__help-panel')).toBeNull());
});
it('presents the existing Flow rerun action as an icon while preserving its accessible title', () => {
    const button = document.createElement('button'); button.title = '重新运行'; button.setAttribute('aria-label', '重新运行');
    presentChatButton(button, 'rerun-arguments'); expect(button.querySelector('svg')).not.toBeNull(); expect(button.textContent).toBe('');
    expect(button.title).toBe('重新运行'); expect(button.getAttribute('aria-label')).toBe('重新运行');
});
