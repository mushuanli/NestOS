// @itookit/ui-common-adapter — shared UI components, contracts, and browser utilities.

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

// ── UI components ──
export * from './components/BaseSettingsEditor';
export {Modal, Toast, showConfirmDialog} from './components/UIComponents';
export type {ModalOptions} from './components/UIComponents';

// ── Browser utilities ──
export { copyText } from './utils/clipboard';
export { setTimePresentation } from './utils/time-presentation';

export { SettingsAutoSave, SettingsValidationError, requestSettingsSave } from './components/SettingsAutoSave';
export type { SettingsSave } from './components/SettingsAutoSave';

export { installNavigationButtonPresentation } from './components/navigation-button';
export * from '@itookit/ui-common';
