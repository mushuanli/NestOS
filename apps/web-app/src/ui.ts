import { createMindosFlowLibrary } from '@itookit/app-core';
import type { AppUI } from '@itookit/app-shell';
import { createFlowContextMenuConfig, createAIContextMenuConfig,
    installFlowLibrary, restoreFlowLibrary } from '@itookit/llm-ui/startup';
import { ProviderSettingsEditor, ConnectionSettingsEditor, MCPSettingsEditor,
    CostEditor, SystemPromptSettingsEditor } from '@itookit/llm-settings-ui';

type EditorFactory = ReturnType<AppUI['createChatEditor']>;

function lazyEditorFactory(load: () => Promise<EditorFactory>): EditorFactory {
    let pending: Promise<EditorFactory> | undefined;
    return async (container, options) => (await (pending ??= load()))(container, options);
}

export function createBrowserUI(): AppUI {
    return {
        createChatEditor: (service, deps) => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui/chat')).createLLMFactory(service, deps)),
        createAgentEditor: (service, capabilities) => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui/settings')).createAgentEditorFactory(service, capabilities)),
        createFlowEditor: deps => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui/chat')).createFlowsEditorFactory(deps)),
        createFlowContextMenu: deps => createFlowContextMenuConfig({ ...deps, library: createMindosFlowLibrary() }),
        installFlowLibrary: commands => installFlowLibrary(commands, createMindosFlowLibrary()),
        restoreFlowLibrary: commands => restoreFlowLibrary(commands, createMindosFlowLibrary()),
        createSkillEditor: service => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui/settings')).createSkillsEditorFactory(service)),
        createAIContextMenu: createAIContextMenuConfig,
        llmUiEditors: {
            ProviderSettingsEditor,
            ConnectionSettingsEditor,
            MCPSettingsEditor,
            CostEditor,
            SystemPromptSettingsEditor,
        },
    };
}
