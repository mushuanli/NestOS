import { FSError, type FSErrorCode } from '@itookit/vfs-core';
import { setStorageAvailable } from './connection-state';

export class HttpTransport {
    constructor(private readonly endpoint = '/api/vfs', private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

    async call<T>(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
        let response: Response;
        try {
            response = await this.fetcher(this.endpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method, args }), signal,
            });
        } catch (error) {
            if (signal?.aborted) throw error;
            setStorageAvailable(false);
            throw new FSError('EIO', `HTTP storage connection failed: ${method}`, method, undefined, error instanceof Error ? error : undefined);
        }
        setStorageAvailable(true);
        const payload = await response.json() as { result?: T; error?: { code: FSErrorCode; message: string } };
        if (!response.ok) {
            const id = response.headers.get('X-Request-ID');
            const request = id && /^[a-f0-9-]{36}$/.test(id) ? ` (requestId=${id})` : '';
            throw new FSError(payload.error?.code ?? 'EIO', (payload.error?.message ?? `HTTP ${response.status}`) + request);
        }
        return payload.result as T;
    }
}
