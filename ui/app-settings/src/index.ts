export type { InitialFilesPort } from './editors/initial-files';
export type { WorkspaceFileSource } from '@itookit/app-contracts/settings';
// @file: app-settings/index.ts
import './styles/styles.css';
import { SettingsEngine } from './engine/SettingsEngine';

export * from './types/types';
export { createSettingsFactory, type LLMUIEditors, type SettingsFactoryOptions } from './factories/settingsFactory';

/** Settings navigation is local presentation and does not load settings data. */
export function createSettingsNavigation(options: { excludedPages?: readonly string[] } = {}) {
    return new SettingsEngine(options.excludedPages);
}
