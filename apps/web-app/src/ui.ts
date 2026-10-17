import type { AppUI } from '@itookit/app-shell';
import { createFlowContextMenuConfig, createAIContextMenuConfig,
    restoreFlowLibrary } from '@itookit/llm-ui-adapter/startup';
import { ProviderSettingsEditor, ConnectionSettingsEditor, MCPSettingsEditor,
    CostEditor, SystemPromptSettingsEditor } from '@itookit/llm-settings-ui';

import {loadChatEditor} from './editor-modules';
export {preloadBrowserEditor} from './editor-modules';

type EditorFactory = ReturnType<AppUI['createChatEditor']>;

function lazyEditorFactory(load: () => Promise<EditorFactory>): EditorFactory {
    let pending: Promise<EditorFactory> | undefined;
    return async (container, options) => (await (pending ??= load()))(container, options);
}

export function createBrowserUI(library: Parameters<typeof restoreFlowLibrary>[1]): AppUI {
    return {
        createChatEditor: (service, deps) => lazyEditorFactory(async () =>
            (await loadChatEditor()).createLLMFactory(service, deps)),
        createAgentEditor: (service, capabilities) => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui-adapter/settings')).createAgentEditorFactory(service, capabilities)),
        createFlowEditor: deps => lazyEditorFactory(async () =>
            (await loadChatEditor()).createFlowsEditorFactory(deps)),
        createFlowContextMenu: deps => createFlowContextMenuConfig({ ...deps, library: library }),
        restoreFlowLibrary: commands => restoreFlowLibrary(commands, library),
        createSkillEditor: service => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui-adapter/settings')).createSkillsEditorFactory(service)),
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
