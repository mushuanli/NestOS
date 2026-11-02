import type {ApplicationClient} from '@itookit/app-contracts/services';
import type {CommandOptions} from './commands';
import {jsonFile} from './application-kanban';

export async function agentCommand(client: ApplicationClient, args: string[], options: CommandOptions): Promise<unknown> {
    const service = client.services.agentService, [action, id] = args;
    if (action === 'list') return (await service.getAgents()).map(({id, name, execution}) => ({id, name, execution}));
    if (action === 'show' && id) return service.getAgentConfig(id);
    if (action === 'status' && id && service.getAgentPublicationStatus) return service.getAgentPublicationStatus(id);
    if (action === 'save') return service.saveAgent(await jsonFile(options.file), {onDuplicate: 'error'});
    if (action === 'publish' && service.publishAgent) return service.publishAgent(await jsonFile(options.file));
    if (action === 'receipt' && service.getAgentPublicationReceipt) return service.getAgentPublicationReceipt(await jsonFile(options.file));
    if (action === 'connections' && service.getHarnessConnections) return service.getHarnessConnections();
    if (action === 'targets' && service.getHarnessConnectionTargets) return service.getHarnessConnectionTargets();
    if (action === 'bind' && service.saveHarnessConnection) {
        const request = await jsonFile<{connection: Parameters<NonNullable<typeof service.saveHarnessConnection>>[0]; expectedRevision: number}>(options.file);
        return service.saveHarnessConnection(request.connection, request.expectedRevision);
    }
    throw new Error('agent requires list/show/status/save/publish/receipt/connections/targets/bind; the host must support the selected capability');
}
