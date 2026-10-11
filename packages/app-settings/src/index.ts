export type { InitialFilesPort } from './editors/initial-files';
import type { WorkspaceFileSource } from './services/workspace-files';
export type { WorkspaceFileSource } from './services/workspace-files';
// @file: app-settings/index.ts
import './styles/styles.css';
import type { IVFSManager } from '@itookit/vfs-core';
import { SettingsService } from './services/SettingsService';
import { SettingsEngine } from './engine/SettingsEngine';

export * from './types/types';
export { createSettingsFactory, type LLMUIEditors } from './factories/settingsFactory';
export { SkillsEngine } from './engine/SkillsEngine';

/**
 * Settings 模块初始化。
 *
 * 使用方式：
 *   const settingsModule = await createSettingsModule(vfs);
 *   const settingsFactory = createSettingsFactory(
 *       settingsModule.service,
 *       agentService,
 *       vfsCore.devices,  // IDeviceManager，供 ConnectionSettingsEditor 使用
 *   );
 */
export async function createSettingsModule(vfs: IVFSManager, workspaces: readonly WorkspaceFileSource[], options: { excludedPages?: readonly string[] } = {}) {
    const service = new SettingsService(vfs, undefined, workspaces);
    await service.init();
    const engine = new SettingsEngine(service, options.excludedPages);
    return { service, engine };
}
