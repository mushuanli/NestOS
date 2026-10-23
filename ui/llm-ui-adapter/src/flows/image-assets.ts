import {InputAssetCommand} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {FlowImageAssetPort} from '../components/FlowImageFields';
const ports = new WeakMap<ICommandBus, FlowImageAssetPort>();
export function flowImageAssets(commands: ICommandBus): FlowImageAssetPort {
    let port = ports.get(commands);
    if (!port) {
        port = {import: url => commands.execute(InputAssetCommand.Import, {url}), read: reference => commands.execute(InputAssetCommand.Read, {reference})};
        ports.set(commands, port);
    }
    return port;
}
