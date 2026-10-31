import {escapeAttr, escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {ToolConnectionType, ToolConnectionView} from '@itookit/app-contracts/services';
const label = (key: string) => escapeHTML(t(`toolbox.connections.${key}` as LocaleKey));

export function applicationSettings(type: ToolConnectionType, redirect?: string): string {
    const application = type.application;
    if (!type.authorization || !application) return '';
    const status = `<p role="status">${label(application.configured ? 'applicationReady' : 'applicationMissing')}</p>`;
    if (!application.canManage) return status;
    return `${status}<details data-connection-details="application:${escapeAttr(type.id)}"><summary>${label('applicationSetup')}</summary>
        <form data-form="oauthApplication" data-type="${escapeAttr(type.id)}"><p>${label('applicationHelp')}</p>
        <label>${label('applicationClientId')}<input name="clientId" required maxlength="16384" value="${escapeAttr(application.clientId ?? '')}"></label>
        ${type.authorization.clientSecretField ? `<label>${label('applicationClientSecret')}<input name="clientSecret" type="password" autocomplete="off" maxlength="16384"${application.hasSecret ? ` placeholder="${label('secretConfigured')}"` : ' required'}></label>` : ''}
        <label>${label('callbackAddress')}<input name="redirectUri" type="url" required maxlength="2048" value="${escapeAttr(application.redirectUri ?? redirect ?? '')}" placeholder="https://nestos.example.com/api/tool-connections/callback"></label>
        <button type="submit">${label('saveApplication')}</button>
        ${application.configured ? `<button type="button" data-application-remove="${escapeAttr(type.id)}">${label('removeApplication')}</button>` : ''}</form></details>`;
}
export function authorizationFields(type: ToolConnectionType, connection?: ToolConnectionView, redirect?: string): string {
    const auth = type.authorization!, operation = connection?.authorization?.operation;
    const stale = operation?.status === 'authorized' && !connection?.authorization?.connected;
    const managed = connection?.authorization?.clientMode === 'application' || type.application && connection?.authorization?.clientMode !== 'personal';
    const callback = managed ? type.application?.redirectUri : redirect;
    return `<fieldset><legend>${label('authorization')}</legend>
        ${callback ? '' : `<p>${label(managed || type.application ? 'applicationMissing' : 'callbackUnconfigured')}</p>`}
        ${auth.permissionGroups.map(group => `<label><input type="checkbox" data-auth-group value="${escapeAttr(group.id)}" checked>${escapeHTML(group.label)}</label>`).join('')}
        <button type="button" data-auth-begin="${escapeAttr(connection?.id ?? 'new:' + type.id)}"${callback ? '' : ' disabled'}>${label(connection ? 'authorize' : 'connectAccount')}</button>
        ${connection?.authorization?.connected ? `<button type="button" data-auth-revoke="${escapeAttr(connection.id)}">${label('revoke')}</button>` : ''}
        <p data-authorization-status="${escapeAttr(connection?.id ?? '')}" role="status">${stale ? label('reauthorize') : operation ? label('authState.' + operation.status) : ''}${operation?.code ? ' · ' + escapeHTML(operation.code) : ''}</p>
        ${operation?.status === 'pending' && operation.url ? `<a href="${escapeAttr(operation.url)}" target="_blank" rel="noopener noreferrer">${label('openAuthorization')}</a>` : ''}
        ${operation && ['pending', 'exchanging'].includes(operation.status) ? `<button type="button" data-auth-cancel="${escapeAttr(operation.operationId)}">${label('cancelAuthorization')}</button>` : ''}</fieldset>`;
}
