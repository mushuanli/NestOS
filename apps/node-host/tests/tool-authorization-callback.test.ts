import type {IncomingMessage, ServerResponse} from 'node:http';
import type {ApplicationRuntime} from '@itookit/app-core';
import {expect, it, vi} from 'vitest';
import {ViewApi} from '../src/http/view-api';

it.each([false, true])('removes callback credentials from the redirect and audit (rejected=%s)', async rejected => {
    const completeAuthorization = vi.fn(async () => {if (rejected) throw Object.assign(new Error('private-provider-body'), {code: 'TOOL_AUTH_STATE_INVALID'});});
    const runtime = {toolConnections: {completeAuthorization}} as unknown as ApplicationRuntime;
    const write = vi.fn(), api = new ViewApi(Promise.resolve(runtime), {write, close: async () => {}}, false);
    const headers = new Map<string, string>(); let status = 200;
    const response = {setHeader: (name: string, value: string) => headers.set(name, value),
        writeHead: (code: number, values: Record<string, string>) => {status = code; Object.entries(values).forEach(([name, value]) => headers.set(name, value));}, end: vi.fn()} as unknown as ServerResponse;
    try {
        await api.handle({method: 'GET', url: '/api/tool-connections/callback?state=private-state&code=private-code'} as IncomingMessage, response);
        expect(completeAuthorization).toHaveBeenCalledWith({state: 'private-state', code: 'private-code', error: undefined});
        expect(status).toBe(303); expect(headers.get('Location')).toBe('/api/tool-connections/result');
        expect(headers.get('Cache-Control')).toBe('no-store'); expect(headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(JSON.stringify(write.mock.calls)).not.toMatch(/private-state|private-code|private-provider-body/);
        expect(write.mock.calls[0][0]).toMatchObject({result: rejected ? 'failure' : 'success', stage: 'callback'});
        if (rejected) expect(headers.get('X-VFS-Error')).toBe('TOOL_AUTH_STATE_INVALID');
    } finally {await api.close();}
});
