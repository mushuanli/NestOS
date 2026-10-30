import type {ToolConnectionType, ToolOAuthDefinition} from '@itookit/app-contracts/services';
export const authFailure = (code: string) => Object.assign(new Error(code), {code});
export interface OAuthTokenReply {access_token: string; refresh_token?: string; expires_in?: number; scope?: string}
export function validateOAuthRedirect(value: string): void {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/tool-connections/callback' || url.search || url.hash) throw new Error();
    } catch {throw authFailure('TOOL_AUTH_REDIRECT_INVALID');}
}

export function validateOAuth(type: ToolConnectionType): void {
    const definition = type.authorization;
    if (!definition) return;
    if (definition.kind !== 'oauth2' || !definition.permissionGroups.length) throw authFailure('TOOL_AUTH_DEFINITION_INVALID');
    for (const endpoint of [definition.authorizationEndpoint, definition.tokenEndpoint, definition.revocationEndpoint].filter(Boolean)) {
        let url: URL;
        try {url = new URL(endpoint!);} catch {throw authFailure('TOOL_AUTH_ENDPOINT_INVALID');}
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw authFailure('TOOL_AUTH_ENDPOINT_INVALID');
    }
    const fields = [definition.clientIdField, definition.clientSecretField, definition.refreshTokenField].filter(Boolean);
    if (fields.some(name => !type.fields.some(field => field.name === name))
        || !type.fields.find(field => field.name === definition.refreshTokenField)?.secret
        || definition.clientSecretField && !type.fields.find(field => field.name === definition.clientSecretField)?.secret)
        throw authFailure('TOOL_AUTH_DEFINITION_INVALID');
    if (new Set(definition.permissionGroups.map(group => group.id)).size !== definition.permissionGroups.length
        || definition.permissionGroups.some(group => !/^[a-zA-Z0-9._-]{1,80}$/.test(group.id) || !group.scopes.length
            || group.scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 2000 || /\s/.test(scope)))) throw authFailure('TOOL_AUTH_SCOPE_INVALID');
    const reserved = new Set(['client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'code_challenge', 'code_challenge_method']);
    if (Object.entries(definition.authorizationParameters ?? {}).some(([key, value]) => reserved.has(key) || typeof value !== 'string' || value.length > 2000))
        throw authFailure('TOOL_AUTH_DEFINITION_INVALID');
}

/** Only declared provider endpoints receive credentials; redirects and unbounded bodies are refused. */
export async function tokenRequest(definition: ToolOAuthDefinition, values: Record<string, string>, grant: Record<string, string>, fetcher = fetch): Promise<OAuthTokenReply> {
    const body = new URLSearchParams({...grant, client_id: values[definition.clientIdField]});
    if (definition.clientSecretField) body.set('client_secret', values[definition.clientSecretField] ?? '');
    let response: Response;
    try {response = await fetcher(definition.tokenEndpoint, {method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(30000)});}
    catch {throw authFailure('TOOL_AUTH_TRANSPORT_FAILED');}
    const data = await boundedJSON(response);
    if (!response.ok) {
        const codes: Record<string, string> = {invalid_grant: 'TOOL_AUTH_REAUTHORIZE_REQUIRED', invalid_client: 'TOOL_AUTH_CLIENT_INVALID', access_denied: 'TOOL_AUTH_DECLINED'};
        throw authFailure(typeof data.error === 'string' && Object.hasOwn(codes, data.error) ? codes[data.error] : response.status === 429 ? 'TOOL_AUTH_RATE_LIMITED' : 'TOOL_AUTH_TOKEN_REJECTED');
    }
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384
        || data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 16384)
        || data.expires_in !== undefined && (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0)
        || data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.length > 65536))
        throw authFailure('TOOL_AUTH_TOKEN_INVALID');
    return data as unknown as OAuthTokenReply;
}
async function boundedJSON(response: Response): Promise<Record<string, unknown>> {
    const reader = response.body?.getReader(); if (!reader) throw authFailure('TOOL_AUTH_RESPONSE_INVALID');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 1024 * 1024) throw authFailure('TOOL_AUTH_RESPONSE_TOO_LARGE'); chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
        const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw authFailure('TOOL_AUTH_RESPONSE_INVALID');
        return data as Record<string, unknown>;
    } catch (error) {
        if ((error as {code?: string})?.code?.startsWith('TOOL_AUTH_')) throw error;
        throw authFailure('TOOL_AUTH_RESPONSE_INVALID');
    } finally {await reader.cancel().catch(() => {});}
}
