// @itookit/ui-common — shared UI components, contracts, and browser utilities.

// ── Editor / UI contracts ──
export {
    IEditor,
    type EditorOptions,
    type EditorTarget,
    normalizeEditorOptions,
    editorFilePath,
    editorResourceId,
    type EditorHostContext,
    type ConfigurationFormControls,
    type EditorFileReference,
    type EditorEvent,
    type EditorEventMap,
    type EditorEventCallback,
    type SearchResultSource,
    type UnifiedSearchResult,
    type Heading,
    type CollapseExpandResult
} from './interfaces/IEditor';
export { type EditorFactory } from './interfaces/IEditorFactory';
export {
    ISessionUI,
    type MenuItem, type ContextMenuBuilder, type ContextMenuConfig, type SessionUIOptions, type ResourceListOptions, type FileCreationConfig,
    type TagEditorOptions, type TagEditorInstance, type TagEditorFactory,
    type SessionManagerEvent,
    type SessionManagerCallback,
    type SessionUIEventMap
} from './interfaces/ISessionUI';

// ── UI components ──
export * from './components/BaseSettingsEditor';
export * from './components/UIComponents';
export { installResponsiveActions, type ResponsiveActionsOptions } from './components/responsive-actions';

// ── Browser utilities ──
export { copyText } from './utils/clipboard';

export type { Suggestion, IAutocompleteSource } from './interfaces/IAutocompleteSource';

export type { OcrControls, OcrSettingsState } from './interfaces/OcrControls';
export { OcrSettingsForm, renderOcrSettings, readOcrSettings } from './components/OcrSettingsForm';

export type { SessionDraftControls } from './interfaces/SessionDraftControls';

export { SettingsAutoSave, SettingsValidationError, requestSettingsSave } from './components/SettingsAutoSave';
export type { SettingsSave } from './components/SettingsAutoSave';

export type { ConversationAttachment, ConversationControls, ConversationSnapshot, ConversationMessage, ConversationRequest, RemoteAgentControls } from './interfaces/ConversationControls';
export { conversationStatus } from './utils/conversation-status';
