import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRegistryWorkspace, registryManifest } from '../registry-workspace.mjs';
import { workspaceAliases } from '../workspace-sources.mjs';

test('registry mode pins library dependencies while retaining application workspace relationships', () => {
    const input = { dependencies: { '@itookit/core': 'workspace:*', '@itookit/host': 'workspace:*' }, peerDependencies: { '@itookit/core': 'workspace:*' } };
    const result = registryManifest(input, [{ name: '@itookit/core', version: '1.0.0' }]);
    assert.equal(result.dependencies['@itookit/core'], '1.0.0');
    assert.equal(result.dependencies['@itookit/host'], 'workspace:*');
    assert.equal(result.peerDependencies['@itookit/core'], '1.0.0');
    assert.equal(input.dependencies['@itookit/core'], 'workspace:*');
});

test('registry build staging excludes sources and secrets without changing development manifests or lockfiles', t => {
    const root = mkdtempSync(join(tmpdir(), 'registry-staging-')), destination = join(root, 'release');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'packages/host/src'), { recursive: true });
    mkdirSync(join(root, 'libraries/core/src'), { recursive: true });
    mkdirSync(join(root, 'packages/host/src/mdx'), { recursive: true });
    writeFileSync(join(root, 'packages/host/src/mdx/controller.ts'), 'export {};');
    const manifest = { name: 'example', scripts: { preinstall: 'guard' }, dependencies: { '@itookit/core': 'workspace:*' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'packages/host/package.json'), JSON.stringify({ ...manifest, name: '@itookit/host', exports: { '.': './src/index.ts' } }));
    writeFileSync(join(root, 'packages/host/.env.local'), 'secret');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - libraries/*\noverrides:\n  "@itookit/core": "workspace:*"\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'development-lock');
    prepareRegistryWorkspace(root, destination, [{ name: '@itookit/core', version: '1.0.0' }]);
    assert.equal(existsSync(join(destination, 'libraries')), false);
    assert.equal(existsSync(join(destination, 'packages/host/.env.local')), false);
    assert.equal(existsSync(join(destination, 'packages/host/src/mdx/controller.ts')), true);
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), 'development-lock');
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).dependencies['@itookit/core'], 'workspace:*');
    assert.equal(JSON.parse(readFileSync(join(destination, 'package.json'))).scripts.preinstall, undefined);
    assert.ok(workspaceAliases(join(destination, 'apps/web-app')).every(alias => !alias.find.test('@itookit/core')));
    assert.match(readFileSync(join(destination, 'pnpm-workspace.yaml'), 'utf8'), /"@itookit\/core": "1\.0\.0"/);
});
