import {ChatInput} from '../../../llm-ui-adapter/src/components/input/ChatInputView';
import '../../../llm-ui-adapter/src/styles/index.css';
import {imageFileState} from '../../../llm-ui-adapter/src/components/input/image-file-state';
const assert = (value: unknown, text: string) => {if (!value) throw new Error(text);};
async function waitFor(test: () => boolean) {
    for (let i = 0; i < 300; i++) {if (test()) return; await new Promise(resolve => setTimeout(resolve, 30));}
    throw new Error('ChatInput did not become ready');
}
async function original() {
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 1200, 1600); ctx.fillStyle = 'blue'; ctx.fillRect(1200, 0, 1200, 1600);
    return new Promise<File>(resolve => canvas.toBlob(blob => resolve(new File([blob!], 'clipboard.png', {type: 'image/png'}))));
}
async function checks() {
    const passed: string[] = [], host = document.querySelector<HTMLElement>('#input')!, sends: File[][] = [];
    const input = new ChatInput(host, {initialAgents: [{id: 'remote:fixture', name: 'Fixture', attachmentKinds: ['image']}],
        initialConfig: {agentId: 'remote:fixture'}, onSend: async (_text, files) => {sends.push(files); return false;}, onStop() {}});
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea.llm-input__textarea')!, send = host.querySelector<HTMLButtonElement>('.llm-input__btn--send')!;
    textarea.value = 'Inspect images'; textarea.dispatchEvent(new Event('input', {bubbles: true}));
    const file = await original(), data = new DataTransfer(); data.items.add(file); data.items.add(new File([file], file.name, {type: file.type}));
    textarea.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true}));
    await waitFor(() => !send.disabled && host.querySelectorAll('.llm-input__image-edit').length === 2);
    send.click(); await waitFor(() => sends.length === 1);
    const resized = await createImageBitmap(sends[0][0]); assert(resized.width === 1024 && resized.height === 683, 'Pasted file default resize'); resized.close();
    assert(imageFileState(sends[0][0]).original === file || imageFileState(sends[0][0]).original.size === file.size, 'Original kept');
    passed.push('paste and default automatic resize');
    assert(!host.querySelector<HTMLButtonElement>('.llm-input__btn--settings')!.hidden, 'Remote sessions expose image settings');
    const previousPreview = host.querySelector<HTMLImageElement>('.llm-input__image-edit img')!.src;
    host.querySelector<HTMLButtonElement>('.llm-input__image-edit')!.click();
    await waitFor(() => !!document.querySelector('.image-editor__surface img'));
    document.querySelector<HTMLButtonElement>('[data-tool=rect]')!.click();
    await waitFor(() => !!document.querySelector('.image-editor__rect'));
    document.querySelector<HTMLButtonElement>('.image-editor__handle[data-corner=nw]')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true, bubbles: true}));
    const originalCanvas = document.querySelector<HTMLImageElement>('.image-editor__surface img')!.src;
    document.querySelector<HTMLButtonElement>('[data-action=apply-image]')!.click();
    await waitFor(() => !document.querySelector<HTMLButtonElement>('[data-action=apply-image]')!.disabled && !document.querySelector('.image-editor__rect'));
    assert(!!document.querySelector('.llm-image-dialog'), 'Apply keeps the editor open');
    assert(document.querySelector<HTMLImageElement>('.image-editor__surface img')!.src !== originalCanvas, 'Apply updates the current canvas');
    assert(host.querySelector<HTMLImageElement>('.llm-input__image-edit img')!.src === previousPreview, 'Apply does not mutate the draft before Done');
    document.querySelectorAll<HTMLButtonElement>('.image-editor__images button')[1].click();
    await waitFor(() => document.querySelectorAll('.image-editor__images img').length === 2);
    const done = [...document.querySelectorAll<HTMLButtonElement>('.llm-image-dialog header button')].find(button => button.dataset.action === 'finish-images')!;
    done.click(); await waitFor(() => !document.querySelector('.llm-image-dialog'));
    send.click(); await waitFor(() => sends.length === 2);
    assert(imageFileState(sends[1][0]).spec.version === 2, 'Crop persisted on correct image');
    const appliedPreview = host.querySelector<HTMLImageElement>('.llm-input__image-edit img')!.src;
    assert(appliedPreview !== previousPreview && !!host.querySelector('.llm-input__image-edited'), 'Applied attachment gets a new preview and edit indicator');
    const bitmap = await createImageBitmap(await (await fetch(appliedPreview)).blob()), plane = document.createElement('canvas');
    plane.width = bitmap.width; plane.height = bitmap.height; const ctx = plane.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    assert(ctx.getImageData(480, 100, 1, 1).data[2] > 240, 'Thumbnail and outgoing file use the applied crop');
    assert(imageFileState(sends[1][1]).spec.selection.kind === 'none', 'Second image unchanged'); passed.push('multi-image editor completion');
    host.querySelector<HTMLButtonElement>('.llm-input__image-edit')!.click();
    await waitFor(() => !!document.querySelector('.image-editor__surface img'));
    document.querySelector<HTMLButtonElement>('[data-tool=rect]')!.click(); await waitFor(() => !!document.querySelector('.image-editor__rect'));
    document.querySelector<HTMLButtonElement>('[data-action=apply-image]')!.click();
    await waitFor(() => !document.querySelector<HTMLButtonElement>('[data-action=apply-image]')!.disabled && !document.querySelector('.image-editor__rect'));
    const confirm = window.confirm; window.confirm = () => true;
    try {document.querySelector<HTMLButtonElement>('.llm-image-dialog header button')!.click();
        await waitFor(() => !document.querySelector('.llm-image-dialog'));}
    finally {window.confirm = confirm;}
    assert(host.querySelector<HTMLImageElement>('.llm-input__image-edit img')!.src === appliedPreview, 'Cancel discards applied working changes');
    passed.push('apply stays local and cancel preserves the committed attachment');
    const mode = host.querySelector<HTMLSelectElement>('[data-image-resize-mode]')!;
    mode.value = 'max-edge'; mode.dispatchEvent(new Event('change'));
    const edge = host.querySelector<HTMLInputElement>('[data-image-max-edge]')!; edge.value = '2048'; edge.dispatchEvent(new Event('change'));
    await waitFor(() => !send.disabled); send.click(); await waitFor(() => sends.length === 3);
    const large = await createImageBitmap(sends[2][1]); assert(large.width === 2048, 'Custom resize applied to original'); large.close();
    assert(input.getConfig().settings.imageResize?.mode === 'max-edge', 'Session override retained'); passed.push('ChatInput resize override');
    mode.value = 'original'; mode.dispatchEvent(new Event('change')); await waitFor(() => !send.disabled);
    send.click(); await waitFor(() => sends.length === 4);
    const restored = await createImageBitmap(sends[3][1]); assert(restored.width === 2400 && restored.height === 1600, 'Original dimensions restored'); restored.close();
    passed.push('original dimensions from preserved source'); input.destroy(); return passed;
}
Object.assign(window, {runImageChecks: checks});
