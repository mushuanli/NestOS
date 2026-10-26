import {presentChatButton} from './button-presentation';
import {createChatView, type ChatOptions} from '@itookit/llm-ui';
import {createImageEditingPort, type ImageEditingHost} from './image-editing';
export type ImageChatOptions = Omit<ChatOptions, 'source' | 'actions' | 'operations'> & {readonly images?: ImageEditingHost};

/** The adapter owns its image port; storage and borrowed processors remain with the host. */
export async function createImageChatView(container: HTMLElement, options: ChatOptions, images?: ImageEditingHost) {
    options = {...options, presentButton: options.presentButton ?? presentChatButton};
    if (!images) return createChatView(container, options);
    const lifetime = new AbortController(), port = options.imageEditing ? undefined : createImageEditingPort(images);
    try {
        const view = await createChatView(container, {...options,
            imageEditing: options.imageEditing ?? port, upload: options.upload ?? images.upload.bind(images),
            assets: options.assets ?? {read: async id => (await images.read({id, name: id}, {signal: lifetime.signal})).arrayBuffer()}});
        const destroy = view.destroy.bind(view); let closing: Promise<void> | undefined;
        view.destroy = () => closing ??= (async () => {lifetime.abort(); try {await destroy();} finally {await port?.dispose();}})();
        return view;
    } catch (error) {lifetime.abort(); await port?.dispose(); throw error;}
}
