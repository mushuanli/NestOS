import type { HarnessConnectionSnapshot } from '@itookit/kernel-adapters/contracts';
import type { ExecutorConfig } from '../core/types';

export interface HarnessConnectionCatalog {
    getHarnessConnection?(id: string): Promise<HarnessConnectionSnapshot | undefined>;
}

export function isHarnessConnectionSnapshot(value: unknown): value is HarnessConnectionSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return item.version === 1 && item.kind === 'harness' && Number.isSafeInteger(item.revision) && Number(item.revision) >= 1
        && ['id', 'name', 'nodeConnectionId', 'projectId', 'profileId'].every(key => typeof item[key] === 'string' && !!item[key])
        && item.project !== undefined && (item.enabled === undefined || typeof item.enabled === 'boolean');
}

/** Revalidate the current grant while retaining the target accepted with the instruction. */
export async function admitHarnessConnection(catalog: HarnessConnectionCatalog, id: string, saved?: HarnessConnectionSnapshot) {
    const current = await catalog.getHarnessConnection?.(id);
    if (!isHarnessConnectionSnapshot(current) || current.id !== id || current.enabled === false)
        throw harnessError('UNAVAILABLE', 'Harness execution connection is unavailable or unauthorized');
    if (saved && (!isHarnessConnectionSnapshot(saved) || canonical(saved) !== canonical(current)))
        throw harnessError('CHANGED', 'Harness execution connection changed after admission');
    return structuredClone(saved ?? current);
}

export function isHarnessAgentSnapshot(value: unknown): value is ExecutorConfig {
    if (!value || typeof value !== 'object') return false;
    const agent = value as ExecutorConfig;
    return typeof agent.id === 'string' && typeof agent.name === 'string' && typeof agent.agentVersion === 'string'
        && agent.type === 'agent' && agent.execution?.kind === 'harness' && isHarnessConnectionSnapshot(agent.harnessConnection)
        && agent.execution.connectionId === agent.harnessConnection.id;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

function harnessError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code: `HARNESS_CONNECTION_${code}` });
}
