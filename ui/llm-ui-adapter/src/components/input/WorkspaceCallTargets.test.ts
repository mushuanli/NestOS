import {expect, it, vi} from 'vitest';
import {WorkspaceCallTargets} from './WorkspaceCallTargets';
import type {RootTargetCatalog} from '@itookit/llm-session/contracts';

it('refreshes publication metadata after an older in-flight catalog read instead of presenting its stale result', async () => {
    let finish!: (catalog: RootTargetCatalog) => void;
    const fresh: RootTargetCatalog = {entries: [{name: 'Published Flow', target: {kind: 'flow', id: 'worker', version: '1', digest: 'published'}}], issues: []};
    const read = vi.fn(async (): Promise<RootTargetCatalog> => fresh).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const directory = new WorkspaceCallTargets(read, () => {});
    const initial = directory.refresh(), picker = directory.refreshCurrent();
    expect(read).toHaveBeenCalledOnce(); finish({entries: [], issues: []});
    await Promise.all([initial, picker]);
    expect(read).toHaveBeenCalledTimes(2); expect(directory.items()[0].label).toBe('Published Flow');
    directory.dispose();
});
