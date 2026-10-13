import { validateApplicationCommand, validateApplicationQuery } from './validation';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { CONFIGURATION_READS, type ConfigurationOperation, type ConfigurationRequest } from './configuration-contracts';

/** Readiness belongs to the capability; unrelated workspaces do not wait for it. */
export class ApplicationConfiguration {
    constructor(private readonly service: IAgentManagementService, private readonly ready: () => Promise<void>) {}
    async invoke(request: ConfigurationRequest<ConfigurationOperation>): Promise<unknown> {
        if ((CONFIGURATION_READS as readonly string[]).includes(request.operation)) validateApplicationQuery('configuration', request);
        else validateApplicationCommand('configuration', request);
        await this.ready();
        if (needsAgents(request)) await this.service.init();
        const operation = this.service[request.operation];
        // The validated operation union contains only public configuration capabilities.
        return Reflect.apply(operation, this.service, request.args);
    }
}

function needsAgents(request: ConfigurationRequest<ConfigurationOperation>): boolean {
    if (request.operation === 'restoreItem') return request.args[0] === 'agent';
    return ['getAgents', 'getAgentConfig', 'saveAgent', 'deleteAgent', 'listSystemPrompts',
        'getSystemPrompt', 'saveSystemPrompt', 'deleteSystemPrompt', 'getRestorableItems', 'resetAllDefaults'].includes(request.operation);
}
