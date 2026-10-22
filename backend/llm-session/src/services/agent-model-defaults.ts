import { isModelDefaults, modelForOperation, type ModelDefaults } from '@itookit/kernel-adapters/contracts';
import type { IAgentConfigService } from '../contracts';

/** Validate configuration metadata only; runtime admission checks current credentials. */
export async function validateAgentModelDefaults(defaults: ModelDefaults | undefined,
    catalog: Pick<IAgentConfigService, 'getConnection' | 'getProvider'>): Promise<void> {
    if (defaults === undefined) return;
    if (!isModelDefaults(defaults)) throw invalid('INPUT', 'Agent model defaults must map supported purposes to connection identities');
    for (const [purpose, id] of Object.entries(defaults)) {
        const operation = purpose as keyof ModelDefaults;
        const connection = await catalog.getConnection(id);
        if (!connection) throw invalid('CONNECTION_MISSING', `Agent default connection is missing for ${operation}`);
        const provider = catalog.getProvider(connection.providerId);
        if (!provider) throw invalid('PROVIDER_MISSING', `Agent default provider is missing for ${operation}`);
        if (connection.enabled === false) throw invalid('CONNECTION_DISABLED', `Agent default connection is disabled for ${operation}`);
        if (provider.enabled === false) throw invalid('PROVIDER_DISABLED', `Agent default provider is disabled for ${operation}`);
        if (!modelForOperation(connection, provider, operation)) throw invalid('CAPABILITY', `Agent default connection has no configured model for ${operation}`);
    }
}

function invalid(reason: string, message: string): Error {
    return Object.assign(new Error(message), { code: `AGENT_MODEL_DEFAULT_${reason}` });
}
