import {presentChatButton} from './button-presentation';
import type {ChatOptions} from '@itookit/llm-ui';
import {createImageEditingPort, type ImageEditingHost} from './image-editing';
export type ImageChatOptions = Omit<ChatOptions, 'source' | 'actions' | 'operations'> & {readonly images?: ImageEditingHost};

/** Prepare view-owned image resources; processors and storage still belong to the host. */
export function prepareImageChatOptions(options: ChatOptions, images?: ImageEditingHost) {
    const lifetime = new AbortController(), port = images && !options.imageEditing ? createImageEditingPort(images) : undefined;
    const configured: ChatOptions = {...options, presentButton: options.presentButton ?? presentChatButton,
        ...(images ? {imageEditing: options.imageEditing ?? port, upload: options.upload ?? images.upload.bind(images),
            assets: options.assets ?? {read: async (id: string) => (await images.read({id, name: id}, {signal: lifetime.signal})).arrayBuffer()}} : {})};
    return {options: configured, abort: () => lifetime.abort(), release: async () => {lifetime.abort(); await port?.dispose();}};
}
