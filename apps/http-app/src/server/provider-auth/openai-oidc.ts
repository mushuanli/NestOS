import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export interface VerifiedIdentity { subject: string; email?: string }
export interface OAuthTokens { access_token: string; refresh_token: string; id_token: string; scope: string; expires_in: number }
type IdentityFailureCode = 'IDENTITY_PAYLOAD_INVALID' | 'IDENTITY_ISSUER_MISMATCH' | 'IDENTITY_AUDIENCE_MISMATCH'
    | 'IDENTITY_AUTHORIZED_PARTY_MISSING' | 'IDENTITY_AUTHORIZED_PARTY_MISMATCH' | 'IDENTITY_EXPIRY_INVALID'
    | 'IDENTITY_EXPIRED' | 'IDENTITY_SUBJECT_INVALID' | 'IDENTITY_ISSUED_AT_INVALID' | 'IDENTITY_ISSUED_IN_FUTURE'
    | 'IDENTITY_NOT_ACTIVE' | 'IDENTITY_NONCE_MISSING' | 'IDENTITY_NONCE_MISMATCH';
export class OpenAIIdentityError extends Error {
    constructor(readonly code: IdentityFailureCode) { super('OpenAI identity claims verification failed'); }
}
export class OpenAIAuthorizationError extends Error {
    constructor(readonly status?: number, readonly code = status ? 'http_error' : 'network_error', readonly requestId?: string) {
        super(status ? `OpenAI authorization rejected (HTTP ${status})` : 'OpenAI authorization network request failed');
    }
}

/** Network errors never include provider bodies, authorization codes or tokens. */
export class OpenAIOidc {
    private discovery?: Promise<Record<string, unknown>>;
    private keys?: { expires: number; value: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };
    constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}
    async authorizeURL(): Promise<URL> { return this.endpoint('authorization_endpoint'); }
    async exchange(form: Record<string, string>): Promise<OAuthTokens> {
        const url = await this.endpoint('token_endpoint');
        return this.json(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...form, resource: OPENAI_RESOURCE }) }) as unknown as Promise<OAuthTokens>;
    }
    async revoke(clientId: string, refreshToken: string): Promise<boolean> {
        try {
            const response = await this.fetcher(await this.endpoint('revocation_endpoint'), { method: 'POST', redirect: 'error',
                signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }) });
            await response.body?.cancel(); return response.ok;
        } catch { return false; }
    }
    async verify(idToken: string, clientId: string, nonce?: string): Promise<VerifiedIdentity> {
        const parts = idToken.split('.');
        if (parts.length !== 3 || idToken.length > 32_768) throw new Error('Invalid OpenAI identity token');
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported OpenAI signing algorithm');
        let keys = await this.jwks();
        if (!keys.some(key => key.kid === header.kid) && this.keys && this.keys.expires < Date.now() + 270_000) {
            this.keys = undefined; keys = await this.jwks();
        }
        const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
        if (!jwk || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
            throw new Error('OpenAI identity signature verification failed');
        }
        return identity(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), clientId, nonce);
    }
    private async endpoint(name: string): Promise<URL> {
        this.discovery ??= this.json(new URL(OPENAI_ISSUER + '/.well-known/openid-configuration')).catch(error => { this.discovery = undefined; throw error; });
        const data = await this.discovery;
        if (data.issuer !== OPENAI_ISSUER || typeof data[name] !== 'string') throw new Error('Invalid OpenAI discovery');
        const url = new URL(data[name] as string);
        if (url.origin !== OPENAI_ISSUER || url.username || url.password || url.hash) throw new Error('Untrusted OpenAI endpoint');
        return url;
    }
    private async jwks() {
        if (this.keys && this.keys.expires > Date.now()) return this.keys.value;
        const data = await this.json(await this.endpoint('jwks_uri'));
        if (!Array.isArray(data.keys) || data.keys.length > 64) throw new Error('Invalid OpenAI JWKS');
        const value = data.keys as NonNullable<typeof this.keys>['value'];
        this.keys = { expires: Date.now() + 300_000, value }; return value;
    }
    private async json(url: URL, init?: RequestInit): Promise<Record<string, unknown>> {
        let response: Response;
        try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
        catch (error) {
            const timeout = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
            throw new OpenAIAuthorizationError(undefined, timeout ? 'request_timeout' : 'network_error');
        }
        if (!response.ok) throw await responseError(response);
        const text = await boundedText(response);
        try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; }
        catch { /* The caller receives no response body. */ }
        throw new Error('Invalid OpenAI authorization response');
    }
}

const oauthErrors = new Set(['invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope', 'access_denied',
    'unauthorized_client', 'unsupported_grant_type', 'unsupported_country_region_territory', 'temporarily_unavailable', 'server_error']);
async function responseError(response: Response): Promise<OpenAIAuthorizationError> {
    let code = 'http_error';
    try {
        const value = JSON.parse(await boundedText(response));
        const candidate = typeof value?.error === 'string' ? value.error : value?.error?.code;
        if (typeof candidate === 'string' && oauthErrors.has(candidate)) code = candidate;
    } catch { /* Keep the HTTP status even when the provider body is not valid JSON. */ }
    const requestId = response.headers.get('openai-request-id') ?? response.headers.get('x-request-id');
    return new OpenAIAuthorizationError(response.status, code,
        requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? requestId : undefined);
}

async function boundedText(response: Response): Promise<string> {
    if (!response.body) throw new Error('Missing OpenAI authorization response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.length;
            if (bytes > 262_144) throw new Error('OpenAI authorization response exceeds limit');
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function identity(value: unknown, clientId: string, nonce?: string): VerifiedIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpenAIIdentityError('IDENTITY_PAYLOAD_INVALID');
    const claims = value as Record<string, unknown>;
    requireClaim(claims.iss === OPENAI_ISSUER, 'IDENTITY_ISSUER_MISMATCH');
    validateAudience(claims, clientId); validateIdentityTimes(claims);
    requireClaim(typeof claims.sub === 'string' && Boolean(claims.sub), 'IDENTITY_SUBJECT_INVALID');
    if (nonce !== undefined) {
        requireClaim(typeof claims.nonce === 'string', 'IDENTITY_NONCE_MISSING');
        requireClaim(claims.nonce === nonce, 'IDENTITY_NONCE_MISMATCH');
    }
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
}
function validateAudience(claims: Record<string, unknown>, clientId: string): void {
    const audience: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    requireClaim(audience.every(item => typeof item === 'string') && audience.includes(clientId), 'IDENTITY_AUDIENCE_MISMATCH');
    requireClaim(audience.length <= 1 || claims.azp !== undefined, 'IDENTITY_AUTHORIZED_PARTY_MISSING');
    requireClaim(claims.azp === undefined || claims.azp === clientId, 'IDENTITY_AUTHORIZED_PARTY_MISMATCH');
}
function validateIdentityTimes(claims: Record<string, unknown>): void {
    const now = Date.now() / 1000;
    requireNumericDate(claims.exp, 'IDENTITY_EXPIRY_INVALID'); requireClaim(claims.exp > now, 'IDENTITY_EXPIRED');
    requireNumericDate(claims.iat, 'IDENTITY_ISSUED_AT_INVALID'); requireClaim(claims.iat <= now + 60, 'IDENTITY_ISSUED_IN_FUTURE');
    if (claims.nbf !== undefined) {
        requireNumericDate(claims.nbf, 'IDENTITY_NOT_ACTIVE'); requireClaim(claims.nbf <= now + 60, 'IDENTITY_NOT_ACTIVE');
    }
}
function requireNumericDate(value: unknown, code: IdentityFailureCode): asserts value is number {
    requireClaim(typeof value === 'number' && Number.isFinite(value), code);
}
function requireClaim(valid: boolean, code: IdentityFailureCode): asserts valid {
    if (!valid) throw new OpenAIIdentityError(code);
}
