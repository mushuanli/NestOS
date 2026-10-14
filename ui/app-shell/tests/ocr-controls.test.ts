import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { OcrService, createApplicationRuntime, type ApplicationRuntime } from '@itookit/app-core';
import { t } from '@itookit/common';
import { type ILLMService } from '@itookit/driver-llm/contracts';
import type { OcrControls } from '@itookit/ui-common';
import { createOcrControls } from '../src/configuration/ocr-controls';
import { ConfigurationDeletionDialog } from '../src/configuration/delete-dialog';
import { AttachmentManager } from '../../llm-ui/src/components/input/AttachmentManager';

let runtime: ApplicationRuntime;
const cleanup: Array<() => void> = [];
afterEach(async () => { cleanup.splice(0).forEach(close => close()); await runtime?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const agents = runtime.agentService;
    await agents.saveProvider({ baseURL: '', id: 'vision', name: 'Vision', implementation: 'openai-compatible', apiKey: 'test',
        models: [{ id: 'image', name: 'Image', supportsVision: true }, { id: 'text', name: 'Text' }] });
    await agents.saveConnection({ id: 'ocr', name: '<OCR>', providerId: 'vision', tiers: { optimal: 'image' } });
    await agents.saveConnection({ id: 'text', name: 'Text', providerId: 'vision', tiers: { optimal: 'text' } });
    const chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: '# Markdown' } }] });
    const service = new OcrService(await runtime.vfs.openFileSystem('/etc'), agents, { chat } as unknown as ILLMService);
    await service.init();
    const navigate = vi.fn().mockResolvedValue(undefined), controls = createOcrControls(service, agents, navigate);
    return { agents, service, controls, chat, navigate };
}
async function modal() {
    await vi.waitFor(() => expect(document.querySelector('[name="ocr-connection"]')).not.toBeNull());
    return document.querySelector<HTMLElement>('.settings-modal-overlay')!;
}
function attachments(ocr: Pick<OcrControls, 'recognize' | 'configure' | 'label' | 'subscribe'>, initial: File[]) {
    const container = document.createElement('div'); container.innerHTML = '<div class="llm-input__field-wrapper"><textarea></textarea></div><div data-attachments></div><input type="file"><button></button>';
    document.body.append(container);
    let files = initial;
    const manager = new AttachmentManager({ container, textarea: container.querySelector('textarea')!, fileInput: container.querySelector('input')!,
        inputWrapper: container.querySelector('.llm-input__field-wrapper')!, attachmentContainer: container.querySelector('[data-attachments]')!,
        attachBtn: container.querySelector('button')!, ocr: { readSettings: async () => ({ value: {}, connections: [] }), saveSettings: async () => {}, openSettings: async () => {}, ...ocr }, getFiles: () => files, setFiles: value => { files = value; },
        getLoading: () => false, notifyConfigChange: vi.fn() });
    cleanup.push(() => manager.destroy()); manager.renderAttachments();
    return { manager, container, files: () => files, setFiles: (value: File[]) => { files = value; } };
}
it('guides unconfigured recognition, filters models and persists before issuing the image request', async () => {
    const { controls, service, chat } = await setup();
    const result = controls.recognize(new Blob(['image'])); const element = await modal();
    expect(chat).not.toHaveBeenCalled();
    const select = element.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    expect(select.querySelector<HTMLOptionElement>('option[value="text"]')!.disabled).toBe(true);
    expect(element.querySelector('ocr')).toBeNull(); expect(select.textContent).toContain('<OCR>');
    select.value = 'ocr'; element.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await expect(result).resolves.toBe('# Markdown');
    expect(service.snapshot().connectionId).toBe('ocr'); expect(chat).toHaveBeenCalledOnce();
});
it('shares one configuration dialog and cancels without issuing a model request', async () => {
    const { controls, chat } = await setup();
    const first = controls.recognize(new Blob()), second = controls.configure();
    const outcome = expect(first).rejects.toThrow(t('ocr.cancelled'));
    const element = await modal(); expect(document.querySelectorAll('.settings-modal-overlay')).toHaveLength(1);
    element.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click();
    await outcome; await expect(second).resolves.toBe(false); expect(chat).not.toHaveBeenCalled();
});
it('shows current OCR selection beside image attachments and refreshes when settings change', async () => {
    const { controls, service } = await setup();
    const f = attachments(controls, [new File(['img'], 'image.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(f.container.textContent).toContain(t('ocr.unconfigured')));
    f.container.querySelector<HTMLButtonElement>('[data-ocr-configure]')!.click();
    const element = await modal();
    element.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!.value = 'ocr';
    element.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('<OCR> · image'));
    expect(service.snapshot().connectionId).toBe('ocr');
});
it('warns before deleting the OCR connection, its provider or its prompt', async () => {
    const { controls, service } = await setup();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    for (const [entityType, id] of [['connection', 'ocr'], ['provider', 'vision'], ['system-prompt', service.snapshot().systemPromptId]] as const)
        expect(await controls.deletionImpact([{ kind: 'entity', entityType, id }])).toBe(t('ocr.deleteImpact'));
    expect(await controls.deletionImpact([{ kind: 'entity', entityType: 'connection', id: 'text' }])).toBe('');
    const dialog = new ConfigurationDeletionDialog(runtime.configuration, undefined, controls.deletionImpact);
    const pending = dialog.request([{ kind: 'entity', entityType: 'connection', id: 'ocr' }]);
    await vi.waitFor(() => expect(document.body.textContent).toContain(t('ocr.deleteImpact')));
    document.querySelector<HTMLButtonElement>('.settings-modal-cancel')!.click(); await pending;
    expect(await runtime.agentService.getConnection('ocr')).toBeDefined();
});
it('opens the referenced shared prompt from configuration without silently saving draft changes', async () => {
    const { controls, service, navigate } = await setup();
    const pending = controls.configure(), element = await modal();
    element.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!.value = 'ocr';
    element.querySelector<HTMLButtonElement>('[data-ocr-open="prompt"]')!.click();
    await expect(pending).resolves.toBe(false);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ target: 'toolbox', resourceId: '/prompts/' + service.snapshot().systemPromptId }));
    expect(service.snapshot().connectionId).toBeUndefined();
});
it('reports batch failures and preserves the failed image while inserting successful text', async () => {
    const recognize = vi.fn().mockResolvedValueOnce('First text').mockRejectedValueOnce(new Error('Model unavailable'));
    const files = ['first', 'failed', 'unprocessed'].map(name => new File([name], name + '.png', { type: 'image/png' }));
    const f = attachments({ recognize, configure: async () => true, label: async () => 'OCR', subscribe: () => () => {} }, files);
    await f.manager.ocrAllImages();
    expect(recognize).toHaveBeenCalledTimes(2); expect(f.files()).toEqual(files.slice(1));
    expect(f.container.querySelector('textarea')!.value).toBe('First text');
    expect(f.container.textContent).toContain('Model unavailable');
});
it('discards recognition results arriving after the attachment manager is destroyed', async () => {
    let finish!: (text: string) => void;
    const recognize = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const file = new File(['img'], 'image.png', { type: 'image/png' });
    const f = attachments({ recognize, configure: async () => true, label: async () => 'OCR', subscribe: () => () => {} }, [file]);
    const pending = f.manager.ocrImage(file, 0); await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    f.manager.destroy(); finish('Late text'); await pending;
    expect(f.container.querySelector('.llm-input__ocr-panel')).toBeNull(); expect(f.files()).toEqual([file]);
});
it('does not upload an image when recognition is cancelled while configuration is open', async () => {
    const { controls, chat, service } = await setup(), abort = new AbortController();
    const pending = controls.recognize(new Blob(['image']), abort.signal);
    const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const element = await modal(); abort.abort();
    element.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!.value = 'ocr';
    element.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await outcome;
    expect(service.snapshot().connectionId).toBe('ocr'); expect(chat).not.toHaveBeenCalled();
});

it('configures the OCR connection directly in chat settings and offers editing without prompt selection', async () => {
    const { controls, service, agents, navigate } = await setup();
    await agents.saveSystemPrompt({ id: 'tables', name: 'Tables', content: ['Extract tables'] });
    await agents.saveConnection({ id: 'ocr', name: 'OCR', providerId: 'vision', tiers: { fast: 'image', optimal: 'text' } });
    const host = document.createElement('div'); document.body.append(host);
    const view = new ChatInput(host, { ocr: controls, onSend: vi.fn(), onStop: vi.fn() }); cleanup.push(() => view.destroy());
    host.querySelector<HTMLButtonElement>('.llm-input__btn--settings')!.click();
    await vi.waitFor(() => expect(host.querySelector('[name="ocr-connection"]')).not.toBeNull());
    const connection = host.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    expect(connection.querySelector('option[value="ocr"]')?.textContent).toContain('image · ' + t('ocr.tier.fast'));
    connection.value = 'ocr'; connection.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(service.snapshot().connectionId).toBe('ocr'));
    await vi.waitFor(() => expect(host.querySelector('[data-ocr-status]')?.textContent).toBe(t('ocr.saved')));
    expect(host.querySelector('[name="ocr-prompt"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-ocr-open="prompt"]')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ target: 'toolbox', resourceId: '/prompts/' + service.snapshot().systemPromptId }));
    expect(service.snapshot().systemPromptId).not.toBe('tables');
    expect(document.querySelector('.settings-modal-overlay')).toBeNull();
    expect(view.getConfig().settings.connectionId).toBeUndefined();
});
it('updates open chat settings after OCR is changed elsewhere and keeps failed edits visible', async () => {
    const { controls, service } = await setup();
    const host = document.createElement('div'); document.body.append(host);
    const view = new ChatInput(host, { ocr: controls, onSend: vi.fn(), onStop: vi.fn() }); cleanup.push(() => view.destroy());
    host.querySelector<HTMLButtonElement>('.llm-input__btn--settings')!.click();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    await vi.waitFor(() => expect(host.querySelector<HTMLSelectElement>('[name="ocr-connection"]')?.value).toBe('ocr'));
    vi.spyOn(controls, 'saveSettings').mockRejectedValueOnce(new Error('Disk unavailable'));
    const select = host.querySelector<HTMLSelectElement>('[name="ocr-connection"]')!;
    select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(host.textContent).toContain('Disk unavailable'));
    expect(select.value).toBe(''); expect(select.disabled).toBe(false); expect(service.snapshot().connectionId).toBe('ocr');
    await service.save(service.snapshot());
    expect(select.isConnected).toBe(true); expect(host.textContent).toContain('Disk unavailable');
});

it('opens attachment OCR settings without starting batch recognition', async () => {
    const { controls } = await setup(), configure = vi.spyOn(controls, 'configure').mockResolvedValue(false);
    const recognize = vi.spyOn(controls, 'recognize');
    const host = document.createElement('div'); document.body.append(host);
    const view = new ChatInput(host, { ocr: controls, onSend: vi.fn(), onStop: vi.fn() }); cleanup.push(() => view.destroy());
    const input = host.querySelector<HTMLInputElement>('.llm-input__file-input')!;
    Object.defineProperty(input, 'files', { value: ['one', 'two'].map(name => new File([name], name + '.png', { type: 'image/png' })) });
    input.dispatchEvent(new Event('change'));
    host.querySelector<HTMLButtonElement>('[data-ocr-configure]')!.click();
    await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce()); expect(recognize).not.toHaveBeenCalled();
});
