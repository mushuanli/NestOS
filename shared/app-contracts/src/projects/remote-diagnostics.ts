import { createModuleLogger, getLogger, LogLevel } from '@itookit/common';
import { FSError } from '@itookit/vfs-core';

export type MCPConnectionReason = 'ready' | 'catalog-not-loaded' | 'mcp-not-found' | 'unsupported-transport'
    | 'auth-missing' | 'extension-missing' | 'invalid-descriptor' | 'endpoint-mismatch' | 'invalid-endpoint';
export interface MCPConnectionDiagnostic {
    connectionId: string; connectionName?: string; reason: MCPConnectionReason; revision: number;
    configured: {id: string; name: string; reason: MCPConnectionReason}[];
}
interface RemoteFailureContext {
    stage: string; projectId?: string; profileId?: string; sessionId?: string; connectionId?: string;
}
export const remoteLog = createModuleLogger('pi-agent');
const reported = new WeakSet<object>();

/** Only catalog identities and fixed reason codes cross the diagnostic boundary. */
export class RemoteConnectionUnavailableError extends FSError {
    constructor(readonly diagnostic: MCPConnectionDiagnostic, readonly projectIds: string[]) {
        super('ENOENT', 'Project MCP connection unavailable', 'remote-connection');
        this.name = 'RemoteConnectionUnavailableError';
    }
}

export function reportRemoteFailure(error: unknown, context: RemoteFailureContext): void {
    if (error instanceof FSError && error.code === 'ECANCELLED') return;
    const [code, ...causeCodes] = failureCodes(error);
    const data = {source: 'itookit', ...context, code, ...(causeCodes.length ? {causeCodes} : {}),
        ...(error instanceof RemoteConnectionUnavailableError
            ? {...error.diagnostic, projectIds: error.projectIds, stack: error.stack} : {})};
    if (error instanceof Error && reported.has(error)) { remoteLog.debug('remote.operation.failed', data); return; }
    if (error instanceof Error) reported.add(error);
    remoteLog.error('remote.operation.failed', data);
    if (getLogger().getLevel('pi-agent') <= LogLevel.ERROR)
        console.error(`${new Date().toISOString()} [itookit/pi-agent] remote.operation.failed`, data);
}

function failureCodes(error: unknown): string[] {
    const codes: string[] = [], seen = new Set<Error>();
    for (let depth = 0; depth < 8 && error instanceof Error && !seen.has(error); depth++) {
        seen.add(error);
        const code = (error as Error & {code?: unknown}).code;
        if (typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(code)) codes.push(code);
        error = error.cause;
    }
    return codes;
}
