export { createSessionChatBinding, createSessionChatView } from './independent/session';
export type { SessionChatBindingOptions } from './independent/session';
export { createNativeChatBinding, createNativeChatView } from './independent/native';
export type { NativeChatBindingOptions } from './independent/native';

export type {NativeCommandProvider} from './independent/native-composer';
export {createImageEditingPort} from './independent/image-editing';
export type {ImageEditingHost, ImageAssetMetadata} from './independent/image-editing';

export type {ImageChatOptions} from './independent/image-chat-view';

export type {InteractionDraftStorage, InteractionDraftScope, InteractionDraftContent, InteractionDraftRecord, InteractionDraftWrite} from './domain/interaction-draft';
export {InteractionDraftPersistence} from './services/InteractionDraftPersistence';
