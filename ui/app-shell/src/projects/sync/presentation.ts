import { t } from '@itookit/common';
import type { MCPConnectionDiagnostic } from '@itookit/app-contracts';
import type { SyncState } from '@itookit/vfs-sync';
import { localizeConnectionReason } from '../../files/localize-mount-error';

export interface SyncConnectionStatus extends Pick<MCPConnectionDiagnostic, 'reason' | 'connectionName'> {offline?: boolean}
export interface ProjectSyncIndicator {
    state: 'configured' | 'pending' | 'error'; label: string; target?: string; direction?: string; issues: string[];
}
interface StatusOptions {connection?: SyncConnectionStatus; conflicts?: number; readError?: string}

export function projectSyncIndicator(state: SyncState | null | undefined, options: StatusOptions): ProjectSyncIndicator | undefined {
    if (options.readError) return indicator('error', [t('project.sync.issue.read', {reason: options.readError})]);
    if (!state || !visibleBinding(state)) return;
    const issues = [...connectionIssues(options.connection), ...pendingIssues(state)];
    if (options.conflicts) issues.push(t('project.sync.issue.conflicts', {count: options.conflicts}));
    return {...indicator(statusLevel(state, options.connection, issues), issues),
        target: [options.connection?.connectionName, state.binding.projectId].filter(Boolean).join(': '),
        direction: t(`project.sync.${state.binding.direction}`)};
}
function visibleBinding(state: SyncState): boolean {
    return state.binding.state !== 'detached' || !!state.pending || !!state.activePlanId;
}
function connectionIssues(connection?: SyncConnectionStatus): string[] {
    const issues: string[] = [];
    if (connection?.reason === 'mcp-not-found') issues.push(t('project.sync.issue.connectionMissing'));
    else if (connection && connection.reason !== 'ready') issues.push(localizeConnectionReason(connection));
    if (connection?.offline) issues.push(t('project.sync.issue.connectionOffline'));
    return issues;
}
function statusLevel(state: SyncState, connection: SyncConnectionStatus | undefined, issues: string[]): ProjectSyncIndicator['state'] {
    const error = !!state.ackError || !!state.pending?.terminalExpired || !!connection?.offline
        || !!connection && connection.reason !== 'ready';
    if (error) return 'error';
    return issues.length ? 'pending' : 'configured';
}
function pendingIssues(state: SyncState): string[] {
    const issues: string[] = [];
    if (state.binding.state === 'detached') issues.push(t('project.sync.issue.detached'));
    if (state.setupPending) issues.push(t('project.sync.issue.setupPending'));
    if (state.pending) issues.push(t(state.pending.terminalExpired ? 'project.sync.issue.expired' : 'project.sync.issue.pending'));
    if (state.activePlanId) issues.push(t('project.sync.issue.plan'));
    if (state.ackError) issues.push(t('project.sync.issue.ack', {code: state.ackError.code}));
    return issues;
}
function indicator(state: ProjectSyncIndicator['state'], issues: string[]): ProjectSyncIndicator {
    return {state, issues, label: t(`project.sync.indicator.${state}`)};
}
export function syncIndicatorDescription(value: ProjectSyncIndicator): string {
    return [value.label, value.target && t('project.sync.indicator.target', {name: value.target}), value.direction,
        ...value.issues.map(issue => `• ${issue}`)].filter(Boolean).join('\n');
}
