import { describe, expect, it, vi } from 'vitest';
import { SessionService } from '../../services/SessionService';

describe('LLM rename synchronization', () => {
    it('uses the stored Session title without modifying it on load', async () => {
        const updateManifest = vi.fn(async () => {});
        const engine = {
            getManifest: vi.fn(async () => ({ title: 'Old' })),
            updateManifest,
        };
        const commands = { execute: vi.fn(async () => ({ sessionId: 'session', sessions: [] })) };
        // Constructed normally: the service keeps per-instance projection state.
        const service = new SessionService(engine as never, commands as never) as any;
        const { title } = await service.loadSession('session', 'New');

        expect(title).toBe('Old');
        expect(updateManifest).not.toHaveBeenCalled();
    });
});
