import {expect, it, vi} from 'vitest';
import {RemoteSessionProjection} from '../src/session/remote-session-projection';
import type {ProjectService} from '@itookit/app-contracts/services';
const project = {id: 'folder', path: '/remote', name: 'Remote', createdAt: 1, updatedAt: 1, project: {id: 'p'}};
function fixture() {
    const client = {profiles: vi.fn(async () => ({profiles: [{id: 'codex', kind: 'codex', projectRuntime: true, capabilities: {history: true}}]})),
        list: vi.fn(async () => ({sessions: [{id: 'native', title: '', status: 'active', resumable: true, updatedAt: 1}], nextCursor: null})), close: vi.fn(async () => {})};
    const projectHarness = vi.fn(async () => client);
    const projection = new RemoteSessionProjection({remoteMounts: {list: () => [{at: '/', connectionId: 'conn', serverProjectId: 'remote-project', access: 'rw'}], projectHarness}} as unknown as ProjectService);
    return {projection, projectHarness};
}
it.each(['remote:' + encodeURIComponent(JSON.stringify(['conn', 'remote-project', 'codex'])), 'remote:' + JSON.stringify(['conn', 'codex'])])
('keeps unnamed native sessions visible when filtering with current or legacy executor identities: %s', async agent => {
    const f = fixture(), timeline = await f.projection.timeline(project, agent);
    expect(timeline.sources).toHaveLength(1);
    const page = await timeline.sources[0].read();
    expect(page.nodes).toHaveLength(1); expect(page.nodes[0].metadata.title).toBeTruthy();
    expect(page.nodes[0].path).toContain('native'); await timeline.close();
});
it('does not let another remote project or connection match a profile with the same name', async () => {
    const f = fixture();
    for (const ids of [['conn', 'other-project', 'codex'], ['other-conn', 'remote-project', 'codex']]) {
        expect((await f.projection.timeline(project, 'remote:' + encodeURIComponent(JSON.stringify(ids)))).sources).toHaveLength(0);
    }
    expect(f.projectHarness).not.toHaveBeenCalled();
});
