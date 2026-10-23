import { isModelOperation } from '@itookit/kernel-adapters/contracts';
import {flowImageAssets} from './image-assets';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand, inferFlowConnectionRequirements } from '@itookit/llm-session/contracts';
import type { FlowConnectionSelection } from '../components/FlowParameterForm';

/** Keep run settings separate from the Flow's parameter namespace. */
export async function flowConnectionSelection(commands: ICommandBus, selected?: string, slots?: import('@itookit/llm-flow/contracts').FlowConnection[], bindings?: Record<string, string>, flow?: import('@itookit/llm-flow/contracts').FlowDraft | import('@itookit/llm-flow/contracts').FlowRevision,
    agent?: {id: string; modelDefaults?: import('@itookit/kernel-adapters/contracts').ModelDefaults}): Promise<FlowConnectionSelection> {
    const { connections, modelDefaults } = await commands.execute<{ connections: FlowConnectionSelection['connections']; modelDefaults?: import('@itookit/kernel-adapters/contracts').ModelDefaults }>(SessionCommand.GetConnections);
    slots = inferFlowConnectionRequirements({nodes: flow?.nodes ?? [], connections: slots ?? flow?.connections,
        parameters: flow?.parameters, inputGroups: flow?.inputGroups});
    const defaults = { ...bindings };
    const purposeDefaults = {...modelDefaults, ...agent?.modelDefaults};
    for (const slot of slots ?? []) {
        if (slot.required === false && !slot.requiredWhen || slot.connectionId !== undefined || Object.hasOwn(defaults, slot.name)) continue;
        if (slot.requirements?.inputModalities?.some(modality => modality !== 'text')) continue;
        const operation = slot.requirements?.operation ?? 'chat';
        if (!isModelOperation(operation)) continue;
        const id = purposeDefaults[operation], candidate = connections.find(item => item.id === id);
        if (candidate && candidate.enabled !== false && candidate.credentialsReady !== false
            && !(candidate.credentialsReady === undefined && candidate.hasApiKey === false)
            && (!candidate.operationModels || candidate.operationModels[operation])) defaults[slot.name] = candidate.id;
    }
    const selection: FlowConnectionSelection = { assets: flowImageAssets(commands), connections, selected, slots, bindings: defaults, onChange: id => { selection.selected = id; } };
    if (flow) selection.validate = async parameters => {
        await commands.execute(SessionCommand.CheckFlowConnections, {flow, parameters, connectionId: selection.selected, connectionBindings: selection.bindings, ...(agent ? {agentId: agent.id} : {})});
    };
    return selection;
}
