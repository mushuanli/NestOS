// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import type {ProjectService} from '@itookit/app-contracts/services';
import {sessionUrl, kanbanReferenceLink} from '../src/kanban/links';
it('uses stable execution and native Session routes and resolves the bound project instead of the current selection', async () => {
    const get = vi.fn(async () => ({path: '/x1'})), resolve = kanbanReferenceLink({get} as unknown as Pick<ProjectService, 'get'>);
    expect(sessionUrl('execution')).toContain('#/workbench/execution');
    expect(await resolve({system: 'nestos-execution-session', id: 'execution', revision: 'attempt'})).toMatchObject({href: sessionUrl('execution'), sessionId: 'execution'});
    const native = await resolve({system: 'nestos-native-session', id: 'native', revision: JSON.stringify({projectId: 'x1', profileId: 'codex', dispatchId: 'attempt'})});
    expect(get).toHaveBeenCalledWith('x1');
    expect(decodeURIComponent(native!.href.split('#/workbench/')[1])).toBe('/folder:x1/@harness/codex/native');
    expect(native!.sessionId).toBe('/folder:x1/@harness/codex/native');
    expect(await resolve({system: 'other', id: 'opaque'})).toBeUndefined();
    expect(await resolve({system: 'nestos-native-session', id: 'native', revision: 'INVALID'})).toBeUndefined();
});
