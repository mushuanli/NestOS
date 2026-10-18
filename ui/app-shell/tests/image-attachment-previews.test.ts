// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {AttachmentImagePreviews} from '../../llm-ui-adapter/src/components/input/AttachmentImagePreviews';
import {ChatInputTemplates} from '../../llm-ui-adapter/src/components/templates/ChatInputTemplates';
import {setImageFileState} from '../../llm-ui-adapter/src/components/input/image-file-state';
afterEach(() => vi.unstubAllGlobals());
it('replaces the visible thumbnail for an applied file and releases replaced and removed URLs', () => {
    let id = 0; const create = vi.fn(() => `blob:version-${++id}`), revoke = vi.fn();
    vi.stubGlobal('URL', {createObjectURL: create, revokeObjectURL: revoke});
    const original = new File(['original'], 'same.png', {type: 'image/png'}), applied = new File(['crop'], 'same.png', {type: 'image/png'});
    setImageFileState(original, {id: 'same-item', revision: 0, original, spec: {version: 1, selection: {kind: 'none'}}, resizeKey: 'ready'});
    setImageFileState(applied, {resizeKey: 'ready', id: 'same-item', revision: 1, original, spec: {version: 1, selection: {kind: 'rect', x: 0.5, y: 0, width: 0.5, height: 1}}});
    const view = new AttachmentImagePreviews(), host = document.createElement('div'), edit = vi.fn();
    const render = (files: File[]) => {host.innerHTML = ChatInputTemplates.renderAttachments(files); view.render(files, host, edit);};
    render([original]); const before = host.querySelector<HTMLImageElement>('img')!.src;
    render([applied]); expect(host.querySelector<HTMLImageElement>('img')!.src).not.toBe(before);
    expect(revoke).toHaveBeenCalledWith(before); expect(host.querySelector('.llm-input__image-edited')!.textContent).toBeTruthy();
    host.querySelector<HTMLButtonElement>('.llm-input__image-edit')!.click(); expect(edit).toHaveBeenCalledWith(applied);
    render([]); expect(revoke).toHaveBeenCalledTimes(2); view.destroy(); expect(revoke).toHaveBeenCalledTimes(2);
});
