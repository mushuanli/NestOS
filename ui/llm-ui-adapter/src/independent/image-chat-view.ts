import {chatAttachmentMenu} from '../shell/chat-attachment-menu';
import {disposeEditorResources} from '../shell/editor-disposal';
import {presentChatButton} from './button-presentation';
import type {ChatOptions} from '@itookit/llm-ui';
import {createImageEditingPort, type ImageEditingHost} from './image-editing';
export type ImageChatOptions = Omit<ChatOptions, 'source' | 'actions' | 'operations'> & {readonly images?: ImageEditingHost};

/** Prepare view-owned image resources; processors and storage still belong to the host. */
export function prepareImageChatOptions(options: ChatOptions, images?: ImageEditingHost): ChatOptions {
    const lifetime = new AbortController(), port = images && !options.imageEditing ? createImageEditingPort(images) : undefined;
    const configured: ChatOptions = {...options, presentButton: options.presentButton ?? presentChatButton, attachmentMenu: options.attachmentMenu ?? chatAttachmentMenu(),
        ...(images ? {imageEditing: options.imageEditing ?? port, upload: options.upload ?? images.upload.bind(images),
            assets: options.assets ?? {read: async (id: string) => (await images.read({id, name: id}, {signal: lifetime.signal})).arrayBuffer()}} : {})};
    return {...configured, release: () => disposeEditorResources([() => options.release?.(),
        () => lifetime.abort(), () => port?.dispose()])};
}
