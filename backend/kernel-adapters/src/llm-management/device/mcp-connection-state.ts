import type { MCPConnectionState } from '@itookit/tools/mcp-contracts';

/** Observations belong to the live manager, independent of saved configuration. */
export class MCPConnectionStates {
    private readonly states = new Map<string, MCPConnectionState>();
    constructor(private readonly changed: () => void) {}
    get(id: string): MCPConnectionState {
        return structuredClone(this.states.get(id) ?? {status: 'idle', issues: []});
    }
    set(id: string, status: MCPConnectionState['status']): void {
        this.states.set(id, {status, checkedAt: Date.now(), issues: []}); this.changed();
    }
    fail(id: string, stage: MCPConnectionState['issues'][number]['stage'], error: unknown): void {
        this.states.set(id, {status: 'error', checkedAt: Date.now(), issues: [{stage, reason: failureReason(error)}]});
        this.changed();
    }
    forget(id: string): void { this.states.delete(id); }
}

function failureReason(error: unknown): MCPConnectionState['issues'][number]['reason'] {
    const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (/401|403|unauthori[sz]ed|authentication|credential|EACCESS/i.test(code + ' ' + detail)) return 'authentication';
    if (/timeout|timed out|ETIMEDOUT/i.test(code + ' ' + detail)) return 'timeout';
    if (/closed|disconnected/i.test(detail)) return 'closed';
    if (/ECONN|ENOTFOUND|fetch|network|ENET|EHOST/i.test(code + ' ' + detail)) return 'network';
    return 'unknown';
}
