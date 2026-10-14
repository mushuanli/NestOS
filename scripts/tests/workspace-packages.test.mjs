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
