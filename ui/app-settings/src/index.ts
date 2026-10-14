export type { InitialFilesPort } from './editors/initial-files';
import type { SettingsPort } from '@itookit/app-contracts/settings';
export type { WorkspaceFileSource } from '@itookit/app-contracts/settings';
// @file: app-settings/index.ts
import './styles/styles.css';
import { SettingsEngine } from './engine/SettingsEngine';

export * from './types/types';
export { createSettingsFactory, type LLMUIEditors } from './factories/settingsFactory';
export { SkillsEngine } from './engine/SkillsEngine';

/** Settings navigation is presentation; the host supplies persistence and maintenance. */
export async function createSettingsModule(service: SettingsPort, options: { background?: boolean; excludedPages?: readonly string[] } = {}) {
    const ready = service.init();
    if (options.background) void ready.catch(error => console.warn('[Settings] Initialization failed', error));
    else await ready;
    const engine = new SettingsEngine(service, options.excludedPages);
    return { service, engine };
}
