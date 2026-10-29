// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import type {ChatView, DraftAttachment} from '@itookit/llm-ui';
import {SharedChatOcr} from './SharedChatOcr';

const panel = vi.hoisted(() => ({showProcessing: vi.fn(), showReview: vi.fn(), showError: vi.fn(), hide: vi.fn(), destroy: vi.fn()}));
vi.mock('../components/input/OcrReviewPanel', () => ({OcrReviewPanel: class {
    showProcessing = panel.showProcessing; showReview = panel.showReview; showError = panel.showError; hide = panel.hide; destroy = panel.destroy;
}}));
vi.mock('../utils/imageDownscale', () => ({downscaleImageForOcr: async (image: Blob) => image}));
afterEach(() => {vi.clearAllMocks(); document.body.replaceChildren();});
function fixture() {
    const item: DraftAttachment = {id: 'image', revision: 2, file: {id: 'asset', name: 'Image', mimeType: 'image/png'}};
    let attachments = [item]; const insert = vi.fn(), remove = vi.fn(() => true), error = vi.fn();
    const view = {getDraft: () => ({attachments}), inputContext: () => ({container: document.body, insertAtCursor: insert}), removeAttachment: remove, focus: vi.fn()} as unknown as ChatView;
    const recognize = vi.fn(async () => 'Recognized text');
    const ocr = new SharedChatOcr({recognize} as never, () => view, async () => new Blob(['image']), error);
    return {ocr, recognize, item, insert, remove, error, replace: () => {attachments = [{...item, revision: 3}];}};
}
it('applies reviewed text with the captured attachment version and preserves other input', async () => {
    const f = fixture(); await f.ocr.actions(f.item)[0].run();
    const callbacks = panel.showReview.mock.calls[0][2]; callbacks.onConfirm('Reviewed text');
    expect(f.remove).toHaveBeenCalledWith({id: 'image', fileId: 'asset', revision: 2});
    expect(f.insert).toHaveBeenCalledWith('Reviewed text'); expect(panel.hide).toHaveBeenCalledOnce(); f.ocr.destroy();
});
it('refuses to consume an image replaced during review', async () => {
    const f = fixture(); await f.ocr.actions(f.item)[0].run(); f.replace();
    panel.showReview.mock.calls[0][2].onConfirm('Obsolete text');
    expect(f.error).toHaveBeenCalledWith(expect.objectContaining({code: 'OCR_ATTACHMENT_CHANGED'}));
    expect(f.remove).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled(); f.ocr.destroy();
});
it('discards late recognition after hiding and keeps failed recognition retryable', async () => {
    const f = fixture(); let finish!: (text: string) => void;
    f.recognize.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const running = f.ocr.actions(f.item)[0].run(); await vi.waitFor(() => expect(f.recognize).toHaveBeenCalledOnce());
    f.ocr.setActive(false); finish('Late text'); await running;
    expect(panel.showReview).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled();
    f.ocr.setActive(true); f.recognize.mockRejectedValueOnce(Object.assign(new Error('OCR offline'), {code: 'OCR_OFFLINE'}));
    await f.ocr.actions(f.item)[0].run(); expect(panel.showError).toHaveBeenCalledWith('OCR offline', expect.any(Function), expect.any(Function));
    expect(f.error).toHaveBeenCalledOnce(); expect(f.remove).not.toHaveBeenCalled(); f.ocr.destroy();
});
