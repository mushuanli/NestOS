import {EventEmitter} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {expect, it, vi} from 'vitest';
import {auditRequest} from '../../node-host/src/logging/audit-log';

it.each([
    ['/assets/chat-abcdefgh.js?token=private-value', 'chat-abcdefgh.js'],
    ['/assets/index-abcdefgh.css', 'index-abcdefgh.css'],
    ['/user/private-document.js', undefined],
    ['/assets/private-name.js', undefined],
])('records only compiled asset identities for %s', (url, asset) => {
    const audit = {write: vi.fn(), close: async () => {}}, response = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(), getHeader: vi.fn(), statusCode: 404, writableFinished: true,
    });
    auditRequest(audit, {url, socket: {remoteAddress: '127.0.0.1'}, method: 'GET', headers: {}} as IncomingMessage,
        response as unknown as ServerResponse, '/ui');
    response.emit('finish');
    const event = audit.write.mock.calls[0][0]; expect(event.asset).toBe(asset);
    expect(JSON.stringify(event)).not.toMatch(/private|token/);
});
