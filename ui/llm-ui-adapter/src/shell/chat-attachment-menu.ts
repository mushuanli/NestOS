import {ACTION_ICONS, CHAT_ICONS, FILE_ICONS, t} from '@itookit/common';
import type {ChatOptions} from '@itookit/llm-ui';

/** Product source choices use the library-owned picker and upload lifecycle. */
export function chatAttachmentMenu(references = false): NonNullable<ChatOptions['attachmentMenu']> {
    return context => [
        {id: 'camera', label: t('chatInput.add.camera'), icon: CHAT_ICONS.camera, run: () => context.pickFiles({accept: 'image/*', capture: 'environment'})},
        {id: 'photoAlbum', label: t('chatInput.add.photoAlbum'), icon: FILE_ICONS.image, run: () => context.pickFiles({accept: 'image/*'})},
        {id: 'attach', label: t('chatInput.add.attach'), icon: ACTION_ICONS.attachment, run: () => context.pickFiles()},
        ...(references ? [{id: 'fileRef', label: t('chatInput.add.fileRef'), icon: FILE_ICONS.file, run: () => {
            context.input.insertAtCursor('@'); context.input.focus(); context.input.textarea.dispatchEvent(new Event('input', {bubbles: true}));
        }}] : []),
    ];
}
