export type { DirectorySourceProvider } from '@itookit/app-contracts/services';
export { workspaceRoot } from '@itookit/app-contracts';
import './styles/workspace.css';
import './styles/digital-twin.css';

export { initApp } from './bootstrap';
export { windowSessionLeaseToken } from './session-owner';
export type { SessionMountRecord, FilesRecord } from '@itookit/app-contracts/services';
export { WS_SETTINGS, WS_CHAT, WS_TOOLBOX, WS_TWIN, WS_AGENTS, WS_MINDS, WS_PROJECTS, WS_EMAILS, WS_PRIVATE, WS_SKILLS, WS_FLOWS, WS_HOME, createWsMount } from './workspaces/index';
export type {
    AppOptions,
    BootWorkspaceParts,
    AppHandle,
    WorkspaceConfig,
    WorkspaceType,
    WorkbenchConfig,
    AppUI,
    ChatEditorDeps,
    FlowEditorDeps,
    AIContextMenuDeps,
    AIContextMenuNode,
} from './types';
export { FILE_REGISTRY } from './config/file-registry';
export type { AppFileTypeConfig, EditorTypeKey } from './config/file-registry';
export * from './config/templates';
export { themeService } from './ThemeService';
export type { ThemeMode } from './ThemeService';
export { Workbench } from './core/Workbench';

export { installMobileNavigation } from './navigation/mobile-navigation';
export { showProjectSyncSetup } from './projects/sync/setup';
export type { ProjectSyncSetupPorts } from './projects/sync/setup';

export { showDirectorySync } from './projects/sync/directory';
export type { DirectorySyncPorts } from './projects/sync/directory';
export { showSyncPreview } from './projects/sync/preview';
