// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCertificates, loadCertificates, startHost} from '@itookit/node-host/http';
import {HttpViewClient} from '@itookit/app-transport/http';
import {authenticatedFetch} from '../../../apps/http-app/tests/tls-fixture';
import {ViewRecovery} from '../../../apps/http-app/src/client/view-recovery';
import {WORKSPACES} from '../../../apps/web-app/src/config/modules';
import {createBrowserUI} from '../../../apps/web-app/src/ui';
import type {AppRecoveryState} from '../src/workbench/recovery';

const releases: Array<() => unknown> = [];
afterEach(async () => {for (const close of releases.splice(0).reverse()) await close(); vi.unstubAllGlobals();});

async function fixture(route = 'toolbox/' + encodeURIComponent('/connections/recovery-connection')) {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    const {initApp} = await import('../src/bootstrap');
    const html = new DOMParser().parseFromString(await readFile('../../apps/web-app/index.html', 'utf8'), 'text/html');
    document.body.replaceWith(document.importNode(html.body, true));
    const directory = await mkdtemp(path.join(tmpdir(), 'mindos-toolbox-recovery-')); releases.push(() => rm(directory, {recursive: true, force: true}));
    const certificates = path.join(directory, 'certs'); await createCertificates(certificates, ['127.0.0.1']);
    const options = {root: path.join(directory, 'data'), sidecar: path.join(directory, 'meta'), authDir: path.join(directory, 'auth'),
        auditFile: path.join(directory, 'audit.jsonl'), certificates: await loadCertificates(certificates), staticDir: directory, host: '127.0.0.1', port: 0, backlog: 32};
    let host = await startHost(options); options.port = (host.server.address() as {port: number}).port; releases.push(() => host.close());
    const auth = await authenticatedFetch(certificates); releases.push(() => auth.close());
    const origin = `https://127.0.0.1:${options.port}/api/application`;
    const seed = new HttpViewClient('seed', origin, auth.fetcher); releases.push(() => seed.close());
    const root = await seed.start();
    await root.services.agentService.saveProvider({id: 'recovery-provider', name: 'Recovery provider', implementation: 'openai-compatible', baseURL: 'https://example.invalid', models: [{id: 'm', name: 'Model'}]});
    await root.services.agentService.saveConnection({id: 'recovery-connection', name: 'Recovery connection', providerId: 'recovery-provider', tiers: {optimal: 'm'}});
    history.replaceState({}, '', '/#/' + route);
    const open = async (recovery?: AppRecoveryState) => {
        const client = new HttpViewClient('toolbox', origin, auth.fetcher); releases.push(() => client.close());
        const opened = await client.start();
        const app = await initApp({...opened, recovery, workspaces: WORKSPACES, defaultSlug: 'start', startPage: true, ui: createBrowserUI(opened.flowLibrary)});
        app.onDestroy(() => client.close(), 'sources'); releases.push(() => app.destroy()); return app;
    };
    return {open, pricing: () => root.services.llmDriver.getPricingConfig?.(), restart: async () => {await seed.close(); await host.close(); host = await startHost(options);}};
}

it('exposes the reviewed vendor price catalog through the HTTP connection service', async () => {
    const f = await fixture();
    expect(f.pricing()?.reference_catalog?.providers.deepseek.sourceUrl).toBe('https://api-docs.deepseek.com/quick_start/pricing/');
    expect(f.pricing()?.reference_catalog?.providers.deepseek.models.length).toBeGreaterThan(0);
});

it('recovers model defaults settings and their eventless search draft after restarting the HTTPS host', async () => {
    const f = await fixture('settings/model-defaults'), app = await f.open();
    await vi.waitFor(() => expect(document.querySelector('[data-default-search]')).not.toBeNull());
    document.querySelector<HTMLInputElement>('[data-default-search]')!.value = 'Recovery model';
    const recovery = new ViewRecovery(app, state => f.open(state));
    await f.restart(); await expect(recovery.recover()).resolves.toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('[data-default-search]')!.value).toBe('Recovery model');
    await recovery.close();
});

it('recovers a toolbox connection deep link and its unsaved name after restarting the HTTPS host', async () => {
    const f = await fixture(), app = await f.open();
    await vi.waitFor(() => expect(document.querySelector('#connection-form [name=name]')).not.toBeNull());
    document.querySelector<HTMLInputElement>('#connection-form [name=name]')!.value = 'Unsent connection edit';
    const recovery = new ViewRecovery(app, state => f.open(state));
    await f.restart();
    expect(document.querySelector<HTMLInputElement>('#connection-form [name=name]')!.value).toBe('Unsent connection edit');
    await expect(recovery.recover()).resolves.toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('#connection-form [name=name]')!.value).toBe('Unsent connection edit');
    expect(() => recovery.current.captureRecovery()).not.toThrow();
    await recovery.close();
});
