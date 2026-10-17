// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {t} from '@itookit/common';
import {ConnectionSettingsEditor} from '../src/editors/ConnectionSettingsEditor';

afterEach(() => {document.body.replaceChildren();});

it.each([
    {model: 'removed', status: 'pending'},
    {model: 'media', status: 'pending'},
    {model: 'chat', tiers: {optimal: 'removed'}, status: 'pending'},
    {model: 'chat', tiers: {optimal: 'media'}, status: 'pending'},
    {model: 'removed', tiers: {optimal: 'chat'}, status: 'ready'},
    {model: 'chat', status: 'ready'},
    {model: 'legacy', status: 'ready'},
    {model: 'chat', credentialsReady: false, status: 'pending'},
    {model: 'chat', providerId: 'missing', status: 'pending'},
    {model: 'chat', enabled: false, status: 'disabled'},
    {model: 'chat', providerEnabled: false, status: 'disabled'},
])('renders readiness from actual catalog membership and tier resolution: %j', async ({status, providerEnabled, ...fields}) => {
    const provider = {id: 'p', name: 'Provider', enabled: providerEnabled, models: [
        {id: 'chat', category: 'chat'}, {id: 'legacy'}, {id: 'media', category: 'image'},
    ]};
    const connection = {id: 'c', name: 'Connection', providerId: 'p', credentialsReady: true, ...fields};
    const service = {getProviders: () => [provider], getConnections: async () => [connection], getDefaultConnection: async () => connection};
    const container = document.createElement('div'); document.body.append(container);
    const editor = new ConnectionSettingsEditor(container, service as never, {} as never);
    try {
        await editor.render();
        const badge = container.querySelector('.settings-connection-card__header .settings-badge--success, .settings-connection-card__header .settings-badge--warning');
        expect(badge?.textContent).toBe(t(`connection.status.${status}`));
        expect(badge?.classList.contains('settings-badge--success')).toBe(status === 'ready');
    } finally {await editor.destroy();}
});
