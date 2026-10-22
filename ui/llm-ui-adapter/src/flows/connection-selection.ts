import { isModelOperation } from '@itookit/kernel-adapters/contracts';
import {flowImageAssets} from './image-assets';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand, inferFlowConnectionRequirements } from '@itookit/llm-session/contracts';
import type { FlowConnectionSelection } from '../components/FlowParameterForm';

/** Keep run settings separate from the Flow's parameter namespace. */
export async function flowConnectionSelection(commands: ICommandBus, selected?: string, slots?: import('@itookit/llm-flow/contracts').FlowConnection[], bindings?: Record<string, string>, flow?: import('@itookit/llm-flow/contracts').FlowDraft | import('@itookit/llm-flow/contracts').FlowRevision): Promise<FlowConnectionSelection> {
    const { connections, modelDefaults } = await commands.execute<{ connections: FlowConnectionSelection['connections']; modelDefaults?: import('@itookit/kernel-adapters/contracts').ModelDefaults }>(SessionCommand.GetConnections);
    slots = inferFlowConnectionRequirements({ nodes: flow?.nodes ?? [], connections: slots ?? flow?.connections });
    const defaults = { ...bindings };
    for (const slot of slots ?? []) {
        if (slot.required === false || slot.connectionId !== undefined || Object.hasOwn(defaults, slot.name)) continue;
        const operation = slot.requirements?.operation ?? 'chat';
        if (!isModelOperation(operation)) continue;
        const id = modelDefaults?.[operation];
        if (id) defaults[slot.name] = id;
    }
    const selection: FlowConnectionSelection = { assets: flowImageAssets(commands), connections, selected, slots, bindings: defaults, onChange: id => { selection.selected = id; } };
    if (flow) selection.validate = async () => {
        await commands.execute(SessionCommand.CheckFlowConnections, {flow, connectionId: selection.selected, connectionBindings: selection.bindings});
    };
    return selection;
}
