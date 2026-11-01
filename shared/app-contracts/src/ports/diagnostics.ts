/** Safe operational metadata; bodies, credentials and raw exceptions never cross this port. */
export interface DiagnosticEvent {
    id: string;
    timestamp: number;
    startedAt?: number;
    module: 'mcp' | 'cells' | 'application';
    operation: string;
    operationId: string;
    stage: string;
    result: 'success' | 'failure' | 'started' | 'cancelled';
    level: 'info' | 'warn' | 'error';
    code?: string;
    causeCodes?: string[];
    rpcCode?: number;
    reason?: string;
    projectId?: string;
    connectionId?: string;
    mountId?: string;
    profileId?: string;
    sessionId?: string;
    requestId?: string;
    durationMs?: number;
    series?: DiagnosticSeries;
}
export interface DiagnosticSeries {
    count: number;
    firstAt: number;
    lastAt: number;
    endedAt?: number;
    ending?: 'recovered' | 'changed' | 'restarted';
    firstOperationId: string;
    firstRequestId?: string;
    samples: Array<{timestamp: number; operationId: string; requestId?: string; durationMs?: number}>;
    minDurationMs?: number;
    maxDurationMs?: number;
    totalDurationMs?: number;
}
export interface DiagnosticQuery {
    projectId?: string;
    connectionId?: string;
    module?: DiagnosticEvent['module'];
    level?: DiagnosticEvent['level'];
    search?: string;
    limit?: number;
    offset?: number;
    startTime?: number;
    endTime?: number;
}
export interface DiagnosticPage {
    events: DiagnosticEvent[];
    retained: number;
    totalOccurrences?: number;
    matchingOccurrences?: number;
    matchingGroups?: number;
    offset?: number;
    limit: number;
    truncated: boolean;
    persistence: 'ready' | 'unavailable' | 'memory';
    persistenceError?: {stage: 'load' | 'write'; code: string};
}
export interface ApplicationDiagnostics {
    query(query?: DiagnosticQuery): Promise<DiagnosticPage>;
    onChange(listener: () => void): () => void;
}
export interface RemoteProjectStatus {
    projectId: string;
    status: 'unknown' | 'checking' | 'online' | 'offline' | 'degraded';
    problem?: 'authorization-denied' | 'binding-outdated' | 'connection-failed' | 'native-unavailable' | 'files-busy';
    issue?: DiagnosticEvent;
    issues?: DiagnosticEvent[];
    checkedAt?: number;
    mounts: Array<{
        mountId: string;
        connectionId?: string;
        status: RemoteProjectStatus['status'];
        checkedAt?: number;
        lastSuccessAt?: number;
        failure?: DiagnosticEvent;
        connectionName?: string;
        protocol?: import('@itookit/tools/mcp-contracts').MCPConnectionState;
        protocolVersion?: string;
        fileProtocol?: string;
        projectProtocol?: string;
        alias?: string;
        root?: string;
        access?: 'ro' | 'rw';
        serverId?: string;
        serverProjectId?: string;
        boundProjectRevision?: number;
        boundPrincipalId?: string;
        principalId?: string;
        boundAuthorizationRevision?: string;
        authorizationRevision?: string;
        authorizationChanged?: boolean;
        authorization?: RemoteAuthorizationInspection;
    }>;
}
export interface RemoteAuthorizationInspection {
    checkedAt: number;
    authentication?: 'accepted' | 'unknown';
    exportAccess: 'unknown' | 'none' | 'ro' | 'rw';
    projectAccess: 'unknown' | 'denied' | 'ro' | 'rw';
    reason: 'available' | 'export-not-granted' | 'project-denied' | 'binding-outdated' | 'unverified';
    projectRevision?: number;
    principalId?: string;
    authorizationRevision?: string;
    capabilities?: {fileRead: boolean; fileWrite: boolean; run: boolean; sessionRead: boolean; sessionControl: boolean};
    code?: string;
    causeCodes?: string[];
}
