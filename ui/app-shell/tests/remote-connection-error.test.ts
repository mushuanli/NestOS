import { it, expect } from 'vitest';
import { setLocale } from '@itookit/common';
import { remoteConnectionError } from '../src/files/remote-connection-error';

it('renders actionable translated messages for each failure, without leaking server text or secrets', () => {
    try {
        for (const locale of ['zh-CN', 'en'] as const) {
            setLocale(locale);
            const errors = [401, 403, 404, 429, 500, 504].map(httpStatus => ({ httpStatus }));
            const messages = [...errors, ...['credential', 'connect', 'protocol'].map(operation => ({ operation })),
                ...['EINVAL', 'ETIMEDOUT', 'ECANCELLED', 'EACCES', 'ENOENT'].map(code => ({ code }))]
                .map(error => remoteConnectionError({ ...error, message: 'secret-password' }));
            for (const message of messages) {
                expect(message).not.toMatch(/remote\./);
                expect(message).not.toContain('secret-password');
                expect(message.length).toBeGreaterThan(0);
            }
            expect(new Set(messages.slice(0, 9)).size).toBe(9);
        }
    } finally { setLocale('zh-CN'); }
});
