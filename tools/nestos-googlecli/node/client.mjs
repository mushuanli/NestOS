export const connectionType = {
    id: 'google-workspace', name: 'Google：Gmail / Calendar',
    description: '连接自己的 Google 账号，只读采集邮件和日历。授权仅属于当前用户。',
    authorization: {
        kind: 'oauth2', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token',
        revocationEndpoint: 'https://oauth2.googleapis.com/revoke', clientIdField: 'clientId', clientSecretField: 'clientSecret', refreshTokenField: 'refreshToken',
        permissionGroups: [{id: 'mail', label: '读取邮件', scopes: ['https://www.googleapis.com/auth/gmail.readonly']},
            {id: 'calendar', label: '读取日程', scopes: ['https://www.googleapis.com/auth/calendar.events.readonly']}],
        authorizationParameters: {access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true'},
    },
    fields: [
        {name: 'clientId', label: 'OAuth Client ID', required: true},
        {name: 'clientSecret', label: 'OAuth Client Secret', secret: true, required: true},
        {name: 'refreshToken', label: 'Refresh Token', secret: true,
            description: '导入授权结果后自动填写；已有连接留空保留。'},
    ],
};
export const fail = code => Object.assign(new Error(code), {code});

/** Response bodies and authorization material must never reach diagnostics. */
export async function jsonRequest(fetcher, url, init, stage) {
    let response;
    try {response = await fetcher(url, {...init, redirect: 'error'});}
    catch (error) {throw Object.assign(fail(error?.name === 'AbortError' || init.signal?.aborted ? 'GOOGLE_CANCELLED' : 'GOOGLE_' + stage + '_NETWORK'),
        {networkCode: safeNetworkCode(error, init.signal)});}
    if (!response.ok) {
        const detail = await readResponse(response, stage).catch(() => undefined);
        const oauth = {invalid_grant: 'REAUTH_REQUIRED', invalid_client: 'CLIENT_INVALID', unauthorized_client: 'CLIENT_UNAUTHORIZED', access_denied: 'DECLINED'};
        if (stage === 'AUTH' && typeof detail?.error === 'string' && Object.hasOwn(oauth, detail.error)) throw fail('GOOGLE_AUTH_' + oauth[detail.error]);
        const reasons = Array.isArray(detail?.error?.errors) ? detail.error.errors.map(item => item?.reason) : [];
        if (reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(reason))) throw fail('GOOGLE_' + stage + '_RATE_LIMITED');
        if (reasons.some(reason => ['accessNotConfigured', 'serviceDisabled'].includes(reason))) throw fail('GOOGLE_' + stage + '_API_DISABLED');
        const category = response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'PERMISSION_DENIED'
            : response.status === 429 ? 'RATE_LIMITED' : response.status === 404 ? 'NOT_FOUND' : 'HTTP_' + response.status;
        throw fail('GOOGLE_' + stage + '_' + category);
    }
    return readResponse(response, stage);
}
function safeNetworkCode(error, signal) {
    if (signal?.reason?.name === 'TimeoutError') return 'TIMEOUT';
    const known = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
    const errors = [error, error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.slice(0, 8) : [])];
    return errors.map(item => item?.code).find(code => known.has(code)) ?? 'UNKNOWN';
}
async function readResponse(response, stage) {
    const limit = 2 * 1024 * 1024, reader = response.body?.getReader();
    if (!reader) throw fail('GOOGLE_' + stage + '_INVALID_RESPONSE');
    const chunks = []; let size = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > limit) throw fail('GOOGLE_' + stage + '_RESPONSE_TOO_LARGE');
            chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
        const result = JSON.parse(new TextDecoder().decode(bytes));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('GOOGLE_' + stage + '_INVALID_RESPONSE');
        return result;
    } catch (error) {throw fail(error?.code?.startsWith('GOOGLE_') ? error.code : 'GOOGLE_' + stage + '_INVALID_RESPONSE');}
    finally {await reader.cancel().catch(() => {});}
}

export async function googleClient(connections, id, signal, fetcher = fetch) {
    if (!connections) throw fail('GOOGLE_USER_CONNECTIONS_UNAVAILABLE');
    let values = await connections.resolve(id, connectionType.id);
    if (connections.accessToken) {
        const access = await connections.accessToken(id, connectionType.id); values = await connections.resolve(id, connectionType.id);
        return authenticatedRequest(connections, id, values, access, signal, fetcher);
    }
    if (!values.clientId || !values.clientSecret || !values.refreshToken) throw fail('GOOGLE_CREDENTIALS_REQUIRED');
    const token = await jsonRequest(fetcher, 'https://oauth2.googleapis.com/token', {method: 'POST', signal,
        body: new URLSearchParams({client_id: values.clientId, client_secret: values.clientSecret, refresh_token: values.refreshToken, grant_type: 'refresh_token'})}, 'AUTH');
    if (typeof token.access_token !== 'string' || !token.access_token) throw fail('GOOGLE_AUTH_INVALID_RESPONSE');
    return authenticatedRequest(connections, id, values, token.access_token, signal, fetcher);
}
function authenticatedRequest(connections, id, values, accessToken, signal, fetcher) {
    const request = async (url, stage) => {
        if (!['https://gmail.googleapis.com', 'https://www.googleapis.com'].includes(new URL(url).origin)) throw fail('GOOGLE_ENDPOINT_INVALID');
        return jsonRequest(fetcher, url, {headers: {Authorization: 'Bearer ' + accessToken}, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)])}, stage);
    };
    request.destinations = {mail: values.mailDirectory || 'imports/mail', calendar: values.calendarDirectory || 'imports/calendar'};
    request.verifyConnection = async () => {
        const current = await connections.resolve(id, connectionType.id);
        if (['clientId', 'clientSecret', 'refreshToken'].some(field => current[field] !== values[field])) throw fail('GOOGLE_CONNECTION_CHANGED');
    };
    return request;
}
