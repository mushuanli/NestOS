// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import {connectApplication} from '../src/client/application-connection';
import {installHttpStatus} from '../src/client/status-banner';
import {t} from '@itookit/common';

const releases: Array<() => unknown> = [];
afterEach(async () => {
    for (const release of releases.splice(0).reverse()) await release();
    document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function connection() {
    vi.spyOn(console, 'error').mockImplementation(() => {}); history.replaceState({}, '', '/#/start');
    const server = new RpcPeer('server', async () => ({})); releases.push(() => server.close());
    const bootstrap = await server.bootstrap({execute: async () => {}, list: () => []});
    let controller!: ReadableStreamDefaultController<Uint8Array>, expired = false;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        if (!init?.method) return new Response(new ReadableStream<Uint8Array>({start(value) {controller = value;}}));
        if (expired) return Response.json({error: {message: 'Expired'}}, {status: 400, headers: {'X-NestOS-View-Expired': '1'}});
        return Response.json(bootstrap);
    });
    const client = connectApplication(); releases.push(() => client.close()); const root = await client.ready;
    return {client, root: root as unknown as {execute(name: string): Promise<void>},
        corrupt: () => controller.enqueue(new TextEncoder().encode('data: invalid\n\n')), expire: () => {expired = true;}};
}

it('replays a fatal update error that occurred before the status UI mounted and preserves an unsent draft', async () => {
    const f = await connection(), states: string[] = [];
    const stop = f.client.subscribeStatus(state => states.push(state)); f.corrupt();
    await vi.waitFor(() => expect(states.at(-1)).toBe('view-error')); stop();
    const draft = document.createElement('textarea'); draft.value = 'Unsent draft'; document.body.append(draft);
    const fetcher = vi.fn(), reload = vi.fn(); releases.push(installHttpStatus({connection: f.client, fetcher, reload}));
    expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.viewError'));
    expect(document.querySelector<HTMLElement>('.http-status')?.hidden).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(draft.value).toBe('Unsent draft');
});

it('replays expiration to a late UI subscriber and checks readiness without repeating the failed operation', async () => {
    const f = await connection(); f.expire();
    await expect(f.root.execute('write')).rejects.toMatchObject({code: 'ECAPABILITY'});
    const fetcher = vi.fn(async () => Response.json({ready: true})), reload = vi.fn();
    releases.push(installHttpStatus({connection: f.client, fetcher, reload}));
    await vi.waitFor(() => expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.viewExpiredReady')));
    expect(fetcher).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
});
