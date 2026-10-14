import { t, type LocaleKey } from '@itookit/common';

/** Fetch hides DNS, TCP, TLS and CORS details; never claim a server is stopped without evidence. */
export function remoteConnectionError(error: unknown): string {
    const detail = error && typeof error === 'object'
        ? error as { code?: string; operation?: string; httpStatus?: number } : {};
    const status = detail.httpStatus;
    if (status === 401) return t('remote.error.authentication');
    if (status === 403) return t('remote.error.permission');
    if (status === 404) return t('remote.error.endpoint');
    if (status === 429) return t('remote.error.busy');
    if (status === 504) return t('remote.error.timeout');
    if (status && status >= 500) return t('remote.error.server', { status });
    if (detail.operation === 'credential') return t('remote.error.credentialsMissing');
    if (detail.operation === 'connect') return t('remote.error.network');
    if (detail.operation === 'protocol') return t('remote.error.protocol');
    const keys: Record<string, LocaleKey> = {
        ETIMEDOUT: 'remote.error.timeout', ECANCELLED: 'remote.error.cancelled',
        EACCES: 'remote.error.permission', EINVAL: 'remote.error.invalid',
        ECAPABILITY: 'remote.error.protocol', EBUSY: 'remote.error.busy',
        ENOENT: 'remote.error.path', ENOTDIR: 'remote.error.path',
    };
    return t(keys[detail.code ?? ''] ?? 'remote.error.unknown');
}
