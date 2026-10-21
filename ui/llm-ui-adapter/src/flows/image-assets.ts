import {InputAssetCommand} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import type {FlowImageAssetPort} from '../components/FlowImageFields';
export function flowImageAssets(commands: ICommandBus): FlowImageAssetPort {
    return {import: url => commands.execute(InputAssetCommand.Import, {url}), read: reference => commands.execute(InputAssetCommand.Read, {reference})};
}
