import type {ToolConnectionInput, ToolConnectionType, ToolConnectionVerification} from '@itookit/app-contracts/services';
import type {PrivateConnection} from './tool-authorization';
import type {OAuthApplication} from './tool-oauth-applications';
import {authFailure} from './tool-oauth-client';

export interface OAuthConnectionRecord extends ToolConnectionInput {revision?: string; authorizedScopes?: string[]; oauthApplicationRevision?: string;
    verification?: ToolConnectionVerification & {revision?: string}}
export function applicationFields(type: ToolConnectionType): string[] {
    const auth = type.authorization; return auth ? [auth.clientIdField, ...(auth.clientSecretField ? [auth.clientSecretField] : [])] : [];
}
export function usesApplication(record: OAuthConnectionRecord, type: ToolConnectionType, application?: OAuthApplication): boolean {
    return Boolean(record.oauthApplicationRevision || application && type.authorization && !record.values[type.authorization.clientIdField]);
}
/** Effective revisions bind caches and token writes to the exact host application identity. */
export function bindOAuthApplication(record: OAuthConnectionRecord, type: ToolConnectionType, application?: OAuthApplication): PrivateConnection {
    if (!usesApplication(record, type, application)) return {...record, values: {...record.values}};
    if (!application || !type.authorization) throw authFailure('TOOL_AUTH_APPLICATION_UNCONFIGURED');
    const auth = type.authorization, valid = record.oauthApplicationRevision === application.revision;
    return {...record, revision: `${record.revision ?? ''}:${application.revision}`, redirectUri: application.redirectUri,
        authorizedScopes: valid ? record.authorizedScopes : [], values: {...record.values,
            [auth.clientIdField]: application.clientId, ...(auth.clientSecretField ? {[auth.clientSecretField]: application.clientSecret ?? ''} : {}),
            [auth.refreshTokenField]: valid ? record.values[auth.refreshTokenField] ?? '' : ''}};
}
export function connectionValues(input: ToolConnectionInput, type: ToolConnectionType, previous?: OAuthConnectionRecord, application?: OAuthApplication): Record<string, string> {
    const auth = type.authorization;
    const managed = Boolean(auth && (previous?.oauthApplicationRevision || application && !input.values[auth.clientIdField] && !previous?.values[auth.clientIdField]));
    const clientFields = managed ? applicationFields(type) : [], values: Record<string, string> = {};
    for (const field of type.fields) {
        const value = input.values[field.name];
        if (value !== undefined && (typeof value !== 'string' || value.length > 16384)) throw authFailure('TOOL_CONNECTION_FIELD_INVALID');
        if (clientFields.includes(field.name)) {if (value) throw authFailure('TOOL_AUTH_APPLICATION_FIELD_MANAGED'); continue;}
        values[field.name] = field.secret && !value ? previous?.values[field.name] ?? '' : value?.trim() ?? '';
        if (field.required && !values[field.name]) throw authFailure('TOOL_CONNECTION_REQUIRED_FIELD');
    }
    return values;
}
