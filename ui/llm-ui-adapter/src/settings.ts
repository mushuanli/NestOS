import {AgentConfigEditor,SkillSettingsEditor,type AgentCapabilityOptions} from './settings/bindings';
export * from './settings/bindings';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import type { EditorFactory } from '@itookit/ui-common-adapter';

export function createSkillsEditorFactory(agentService: IAgentManagementService): EditorFactory {
    return async (container, options) => {
        const editor = SkillSettingsEditor.createFormOnly(container, agentService, options);
        await editor.init(container, options.initialContent ?? '');
        return editor;
    };
}

export function createAgentEditorFactory(agentService: IAgentManagementService, capabilities: AgentCapabilityOptions = {}): EditorFactory {
    const policy = { ...capabilities, defaultToolIds: [...(capabilities.defaultToolIds ?? [])] };
    return async (container, options) => {
        const editor = new AgentConfigEditor(container, options, agentService, policy);
        await editor.init(container, options.initialContent);
        return editor;
    };
}
