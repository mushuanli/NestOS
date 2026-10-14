import { t, type LocaleKey } from '@itookit/common';
import { DirectorySourceUnavailableError, SessionUnfinishedTasksError, RemoteConnectionUnavailableError, type MCPConnectionReason, type MCPConnectionDiagnostic } from '@itookit/app-contracts';

const connectionReasons: Record<MCPConnectionReason, LocaleKey> = {
    'ready': 'remote.connectionReason.ready', 'catalog-not-loaded': 'remote.connectionReason.notLoaded',
    'mcp-not-found': 'remote.connectionReason.missing', 'unsupported-transport': 'remote.connectionReason.transport',
    'auth-missing': 'remote.connectionReason.auth', 'extension-missing': 'remote.connectionReason.extension',
    'invalid-descriptor': 'remote.connectionReason.descriptor', 'endpoint-mismatch': 'remote.connectionReason.endpoint',
    'invalid-endpoint': 'remote.connectionReason.invalidEndpoint',
};
export function localizeConnectionReason(diagnostic: Pick<MCPConnectionDiagnostic, 'reason' | 'connectionName'>): string {
    return t(connectionReasons[diagnostic.reason], {name: diagnostic.connectionName ?? ''});
}

/**
 * Map platform-agnostic mount errors to localized copy.
 *
 * `@itookit/app-core` raises structured errors and owns no user-facing text (see its
 * AGENTS.md); the host decides how to phrase them. Unknown errors pass through unchanged
 * so their message is not swallowed.
 */
export function localizeMountError(error: unknown): unknown {
    let cause = error;
    for (let depth = 0; depth < 16 && cause instanceof Error; depth++, cause = cause.cause) {
        if (cause instanceof RemoteConnectionUnavailableError) {
            return new Error(t('remote.connectionUnavailable', {reason: localizeConnectionReason(cause.diagnostic)}));
        }
    }
    if (error instanceof SessionUnfinishedTasksError) return new Error(t('error.sessionUnfinishedTasks'));
    if (error instanceof DirectorySourceUnavailableError) return new Error(t('error.directorySourceUnavailable'));
    return error;
}
