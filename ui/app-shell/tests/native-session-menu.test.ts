// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {t} from '@itookit/common';
import {nativeSessionMenu} from '../src/projects/remote-session-management';

it('exposes native archive capability and explains when the current state prevents it', () => {
    const menu = (caps: object, archived = false) => nativeSessionMenu(vi.fn(),
        {folder: '/P', profileId: 'codex', nativeSessionId: 's', archived}, 'S', caps, new AbortController().signal,
        vi.fn(), vi.fn(), vi.fn());
    expect(menu({archive: true})).toContainEqual(expect.objectContaining({id: 'native-archive', label: t('harness.archive'), disabled: undefined}));
    expect(menu({archive: true, archiveDisabled: true})).toContainEqual(expect.objectContaining({id: 'native-archive', label: t('harness.archiveUnavailable'), disabled: true}));
    expect(menu({unarchive: true}, true)).toContainEqual(expect.objectContaining({id: 'native-archive', label: t('harness.unarchive'), disabled: false}));
    expect(menu({delete: true})).toContainEqual(expect.objectContaining({id: 'native-delete', label: t('harness.delete')}));
    expect(menu({})).toEqual([]);
});
