import type {HarnessConnectionSnapshot} from '@itookit/kernel-adapters/contracts';
import type {ExecutorConfig} from '../core/types';

/** Execution authority belongs to the selected harness, independently of the prompt identity. */
export function promptHarnessIdentity(identity: ExecutorConfig, connection: HarnessConnectionSnapshot): ExecutorConfig {
    const flow = identity.execution?.kind === 'flow' || identity.type === 'flow';
    return {...identity, ...(flow ? {} : {execution: {kind: 'harness' as const, connectionId: connection.id}}),
        harnessConnection: structuredClone(connection), capabilityPolicy: undefined, memoryPolicy: undefined, defaultContextPolicy: undefined};
}

/** A Flow keeps its graph; only ordinary Agent nodes use the chosen native executor. */
export function promptHarnessNode(config: Record<string, unknown>, connection?: HarnessConnectionSnapshot): Record<string, unknown> {
    if (!connection) return config;
    const result = {...config, execution: {kind: 'harness', connectionId: connection.id}, harnessConnection: structuredClone(connection)};
    for (const key of ['capabilityPolicy', 'toolIds', 'mcpProfileIds', 'skillIds', 'memoryPolicy']) delete (result as Record<string, unknown>)[key];
    return result;
}
