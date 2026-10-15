// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createStartupStatus } from '../../../apps/http-app/src/client/startup-status';

afterEach(() => document.body.replaceChildren());
it('keeps a fatal host failure visible after the shell dismissed the startup banner', () => {
    const status = createStartupStatus(); status.progress('Connecting');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Connecting');
    status.ready(); expect(document.querySelector('.http-startup')).toBeNull();
    status.fail(new Error('Host failed'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host failed');
    expect(document.querySelector('.http-startup button')).not.toBeNull();
});
