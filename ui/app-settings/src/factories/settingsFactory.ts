import type { InitialFilesPort } from '../editors/initial-files';
import type { MCPServer, MCPDiscovery } from '@itookit/tools/mcp-contracts';
import type { ConfigurationFormControls } from '@itookit/ui-common';
import { editorResourceId } from '@itookit/ui-common';
// @file app-settings/factories/settingsFactory.ts
import type { IConnectionService } from '@itookit/kernel-adapters/contracts';
import type { EditorOptions } from '@itookit/ui-common';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import type { EditorFactory, IEditor } from '@itookit/ui-common';
import type { SettingsPort as SettingsService } from '@itookit/app-contracts/settings';
import { SETTINGS_PAGES } from '../engine/SettingsEngine';

import { TagSettingsEditor } from '../editors/TagSettingsEditor';
import { ContactSettingsEditor } from '../editors/ContactSettingsEditor';
import { StorageSettingsEditor } from '../editors/StorageSettingsEditor';
import { AboutSettingsEditor } from '../editors/AboutSettingsEditor';
import { RecoverySettingsEditor } from '../editors/RecoverySettingsEditor';
import { LogSettingsEditor } from '../editors/LogSettingsEditor';
import { SystemFSExploreEditor, type FileBrowserConnector } from '../editors/SystemFSExploreEditor';
import { AppearanceSettingsEditor } from '../editors/AppearanceSettingsEditor';

/** Injected UI editors from @itookit/llm-ui (to avoid upward dependency). */
export interface LLMUIEditors {
    ProviderSettingsEditor: new (container: HTMLElement, service: IConnectionService, options: EditorOptions) => IEditor;
    ConnectionSettingsEditor: new (container: HTMLElement, service: IConnectionService, options: EditorOptions) => IEditor;
    MCPSettingsEditor: new (container: HTMLElement, service: IAgentManagementService, options: EditorOptions, controls?: ConfigurationFormControls<MCPServer,MCPDiscovery>) => IEditor;
    CostEditor: new (container: HTMLElement, service: IAgentManagementService, options: EditorOptions) => IEditor;
    SystemPromptSettingsEditor: new (container: HTMLElement, service: IAgentManagementService, options: EditorOptions) => IEditor;
}

/**
 * VFS-UI 使用 path（如 "/文件系统"）作为 nodeId，而内部编辑器用 slug（如 "storage"）。
 * 此函数将 path → 内部分类 slug，确保 switch 正确匹配。
 */
function resolveSettingsSlug(nodeId: string): string {
    // 直接匹配 slug（向后兼容）
    if (SETTINGS_PAGES[nodeId]) return nodeId;
    // 按 path 反向查找
    for (const [slug, cfg] of Object.entries(SETTINGS_PAGES)) {
        if (`/${cfg.name}` === nodeId) return slug;
    }
    return nodeId;
}

export interface SettingsFactoryOptions {
    settingsService: SettingsService;
    agentService: IAgentManagementService;
    connectionService: IConnectionService;
    llmUiEditors: LLMUIEditors;
    connectBrowser: FileBrowserConnector;
    initialFiles?: InitialFilesPort;
    restoreFlows?: () => Promise<number>;
    requestDelete?: import('@itookit/ui-common').EditorHostContext['requestDelete'];
}
export const createSettingsFactory = ({ settingsService, agentService, connectionService, llmUiEditors,
    connectBrowser, restoreFlows, initialFiles, requestDelete }: SettingsFactoryOptions): EditorFactory => {
    return async (container: HTMLElement, options: EditorOptions) => {
        await settingsService.init();
        if (requestDelete) options = { ...options, hostContext: { toggleSidebar: () => {}, navigate: async () => {}, ...options.hostContext, requestDelete } };
        const nodeId = resolveSettingsSlug(editorResourceId(options) || '');
        await settingsService.init();

        let editor: IEditor | null = null;

        switch (nodeId) {
            case 'storage':     editor = new StorageSettingsEditor(container, settingsService, options, initialFiles); break;
            case 'tags':        editor = new TagSettingsEditor(container, settingsService, options); break;
            case 'contacts':    editor = new ContactSettingsEditor(container, settingsService, options); break;
            case 'providers':   editor = new llmUiEditors.ProviderSettingsEditor(container, connectionService, options); break;
            case 'connections': editor = new llmUiEditors.ConnectionSettingsEditor(container, connectionService, options); break;
            case 'mcp-servers': editor = new llmUiEditors.MCPSettingsEditor(container, agentService, options); break;
            case 'cost':        editor = new llmUiEditors.CostEditor(container, agentService, options); break;
            case 'system-prompts': editor = new llmUiEditors.SystemPromptSettingsEditor(container, agentService, options); break;
            case 'recovery':    editor = new RecoverySettingsEditor(container, agentService, options, restoreFlows, initialFiles); break;
            case 'log':         editor = new LogSettingsEditor(container, settingsService, options); break;
            case 'about':       editor = new AboutSettingsEditor(container, settingsService, options); break;
            case 'fs-explorer': editor = new SystemFSExploreEditor(container, settingsService, options, connectBrowser); break;
            case 'appearance':  editor = new AppearanceSettingsEditor(container, settingsService, options); break;
            default:
                container.innerHTML = `<div style="padding:2rem;text-align:center;color:#666">Select a setting category</div>`;
                return { init: async () => {}, destroy: async () => {}, getText: () => '', setText: () => {}, focus: () => {}, getMode: () => 'render', switchToMode: async () => {}, setTitle: () => {}, setReadOnly: () => {}, isDirty: () => false, setDirty: () => {}, commands: {}, getHeadings: async () => [], getSearchableText: async () => '', getSummary: async () => null, search: async () => [], gotoMatch: () => {}, clearSearch: () => {}, on: () => () => {}, navigateTo: async () => {} } as unknown as IEditor;
        }

        if (editor) {
            // @ts-ignore BaseSettingsEditor has init method
            await editor.init(container);
        }

        return editor!;
    };
};
