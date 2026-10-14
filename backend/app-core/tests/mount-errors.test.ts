import { describe, expect, it } from 'vitest';
import { DirectorySourceUnavailableError, SessionUnfinishedTasksError } from '../src/index';

describe('app-core structured errors', () => {
    it('exposes codes and identity instead of user-facing copy', () => {
        const busy = new SessionUnfinishedTasksError('session-a');
        expect(busy).toMatchObject({ name: 'SessionUnfinishedTasksError', code: 'EBUSY', sessionId: 'session-a' });
        const missing = new DirectorySourceUnavailableError('home');
        expect(missing).toMatchObject({ name: 'DirectorySourceUnavailableError', code: 'EACCES', sourceId: 'home' });
        // The platform-agnostic layer must not own localized text (host maps the code).
        for (const error of [busy, missing]) expect(error.message).not.toMatch(/[\u4e00-\u9fff]/);
    });
});
