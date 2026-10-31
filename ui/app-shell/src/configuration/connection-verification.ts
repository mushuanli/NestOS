import {escapeAttr, escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {ToolConnectionVerification, ToolConnectionView} from '@itookit/app-contracts/services';
const label = (key: string) => t(`toolbox.connections.${key}` as LocaleKey);

export function connectionStatus(connection: ToolConnectionView): string {
    if (connection.verification?.status === 'verified') return label('verificationPassed');
    if (connection.verification?.status === 'failed') return label('verificationFailed');
    if (connection.authorization?.connected && connection.authorization.operation?.status === 'authorized') return label('authorizationGranted');
    return label(connection.authorization && !connection.authorization.connected ? 'authorizationMissing' : 'savedUnverified');
}

export function verificationMessage(result: ToolConnectionVerification): string {
    if (result.status === 'verified') return label('verificationPassedHelp');
    if (result.status === 'unsupported') return label('verificationUnsupported');
    const reasons: Record<string, string> = {TOOL_AUTH_REAUTHORIZE_REQUIRED: 'verificationReauthorize', TOOL_AUTH_CLIENT_INVALID: 'verificationClientInvalid',
        TOOL_AUTH_TRANSPORT_FAILED: 'verificationNetwork', TOOL_AUTH_RATE_LIMITED: 'verificationRateLimit', TOOL_AUTH_SCOPE_NOT_GRANTED: 'verificationScope',
        TOOL_AUTH_CONNECTION_CHANGED: 'verificationChanged', TOOL_AUTH_APPLICATION_UNCONFIGURED: 'applicationMissing', TOOL_AUTH_UNSUPPORTED: 'verificationUnsupported'};
    const key = result.code && Object.hasOwn(reasons, result.code) ? reasons[result.code] : 'verificationRejected';
    return label(key) + (result.code ? ` (${result.code})` : '');
}

export function connectionVerification(connection: ToolConnectionView, canVerify: boolean): string {
    const result = connection.verification;
    return `<p data-connection-verification="${escapeAttr(connection.id)}" role="${result?.status === 'failed' ? 'alert' : 'status'}">${escapeHTML(result ? verificationMessage(result) : connectionStatus(connection))}</p>
        ${result ? `<small>${escapeHTML(label('verificationTime'))} ${escapeHTML(new Date(result.checkedAt).toLocaleString())}</small>` : ''}
        ${canVerify && connection.authorization?.connected ? `<button type="button" data-connection-verify="${escapeAttr(connection.id)}">${escapeHTML(label('verifyConnection'))}</button>` : ''}`;
}
