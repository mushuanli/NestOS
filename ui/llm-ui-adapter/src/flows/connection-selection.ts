import {flowImageAssets} from './image-assets';
import type { ConnectionMeta } from '@itookit/driver-llm/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import type { FlowConnectionSelection } from '../components/FlowParameterForm';

/** Keep run settings separate from the Flow's parameter namespace. */
export async function flowConnectionSelection(commands: ICommandBus, selected?: string, slots?: import('@itookit/llm-flow/contracts').FlowConnection[], bindings?: Record<string, string>, flow?: import('@itookit/llm-flow/contracts').FlowDraft | import('@itookit/llm-flow/contracts').FlowRevision): Promise<FlowConnectionSelection> {
    const { connections } = await commands.execute<{ connections: ConnectionMeta[] }>(SessionCommand.GetConnections);
    const selection: FlowConnectionSelection = { assets: flowImageAssets(commands), connections, selected, slots, bindings: { ...bindings }, onChange: id => { selection.selected = id; } };
    if (flow) selection.validate = async () => {
        await commands.execute(SessionCommand.CheckFlowConnections, {flow, connectionId: selection.selected, connectionBindings: selection.bindings});
    };
    return selection;
}
