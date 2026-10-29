import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorkspace } from '../check-workspace.mjs';
import { workspaceAliases } from '../workspace-sources.mjs';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'workspace-sources-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}
function packageAt(root, group, name, manifest) {
    const directory = join(root, group, name); mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    for (const file of ['index.ts', 'contracts.ts', 'style.css']) writeFileSync(join(directory, 'src', file), '');
}

test('missing source checkouts fail explicitly instead of selecting registry packages', t => {
    const root = fixture(t), catalog = [{ name: '@itookit/core', directory: 'core' }];
    assert.match(checkWorkspace(root, { catalog })[0], /Missing source: libraries\/core/);
    packageAt(root, 'libraries', 'core', { name: '@itookit/core', exports: { '.': './src/index.ts' } });
    assert.deepEqual(checkWorkspace(root, { catalog }), []);
    packageAt(root, 'libraries', 'core', { name: '@itookit/core', exports: { '.': './dist/index.js' } });
    assert.match(checkWorkspace(root, { catalog })[0], /Missing source export/);
});

test('public root, contracts and CSS aliases are exact and follow package exports', t => {
    const root = fixture(t);
    packageAt(root, 'libraries', 'core', { name: '@itookit/core', exports: {
        '.': { import: './src/index.ts' }, './contracts': './src/contracts.ts', './style.css': './src/style.css' } });
    const aliases = workspaceAliases(join(root, 'apps/web-app'));
    for (const [specifier, file] of [['@itookit/core', 'index.ts'], ['@itookit/core/contracts', 'contracts.ts'], ['@itookit/core/style.css', 'style.css']]) {
        assert.equal(aliases.find(alias => alias.find.test(specifier)).replacement, join(root, 'libraries/core/src', file));
    }
    assert.ok(aliases.every(alias => !alias.find.test('@itookit/core/private')));
});

test('applications must declare workspace dependencies and installed links resolve to sources', t => {
    const root = fixture(t), catalog = [{ name: '@itookit/core', directory: 'core' }];
    packageAt(root, 'libraries', 'core', { name: '@itookit/core', exports: { '.': './src/index.ts' } });
    packageAt(root, 'ui', 'host', { name: '@itookit/host', dependencies: { '@itookit/core': '1.0.0' } });
    assert.match(checkWorkspace(root, { catalog })[0], /must use workspace:\*/);
    packageAt(root, 'ui', 'host', { name: '@itookit/host', dependencies: { '@itookit/core': 'workspace:*' } });
    assert.deepEqual(checkWorkspace(root, { catalog }), []);
    assert.match(checkWorkspace(root, { catalog, installed: true })[0], /cannot resolve/);
});

test('internal peers are reported when no application provides them', t => {
    const root = fixture(t), settings = (extra = {}) => ({ name: '@itookit/app-settings', peerDependencies: { '@itookit/ui-common': 'workspace:*' }, ...extra });
    packageAt(root, 'ui', 'ui-common', { name: '@itookit/ui-common' });
    packageAt(root, 'ui', 'app-settings', settings());
    packageAt(root, 'apps', 'web-app', { name: 'nestos-web', dependencies: { '@itookit/app-settings': 'workspace:*' } });
    assert.match(checkWorkspace(root, { catalog: [] })[0], /@itookit\/ui-common: peer of @itookit\/app-settings is provided by no app/);
    packageAt(root, 'ui', 'app-settings', settings({ peerDependenciesMeta: { '@itookit/ui-common': { optional: true } } }));
    assert.deepEqual(checkWorkspace(root, { catalog: [] }), []);
    packageAt(root, 'ui', 'app-settings', { name: '@itookit/app-settings', peerDependencies: { react: '^19.0.0' } });
    assert.deepEqual(checkWorkspace(root, { catalog: [] }), []);
});

test('a host that declares the peer satisfies every declaring package once', t => {
    const root = fixture(t), peers = { '@itookit/ui-common': 'workspace:*' };
    packageAt(root, 'ui', 'ui-common', { name: '@itookit/ui-common' });
    packageAt(root, 'ui', 'app-settings', { name: '@itookit/app-settings', peerDependencies: peers });
    packageAt(root, 'ui', 'app-shell', { name: '@itookit/app-shell', peerDependencies: peers });
    packageAt(root, 'apps', 'http-app', { name: '@itookit/http-app', dependencies: {
        '@itookit/app-settings': 'workspace:*', '@itookit/app-shell': 'workspace:*' } });
    assert.match(checkWorkspace(root, { catalog: [] }).join('\n'), /@itookit\/ui-common: peer of @itookit\/app-settings, @itookit\/app-shell is provided by no app/);
    packageAt(root, 'apps', 'web-app', { name: 'nestos-web', dependencies: { '@itookit/ui-common': 'workspace:*' } });
    assert.deepEqual(checkWorkspace(root, { catalog: [] }), []);
});
