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
    mkdirSync(join(root, 'ui/host/src'), { recursive: true });
    mkdirSync(join(root, 'libraries/core/src'), { recursive: true });
    mkdirSync(join(root, 'tools/image-tools/src'), {recursive: true});
    writeFileSync(join(root, 'tools/image-tools/package.json'), JSON.stringify({name:'@itookit/image-tools',dependencies:{'@itookit/core':'workspace:*'}}));
    writeFileSync(join(root, 'tools/image-tools/src/node.ts'), 'export {};');
    writeFileSync(join(root, 'tools/image-tools/.env.local'), 'secret');
    mkdirSync(join(root, 'ui/host/src/mdx'), { recursive: true });
    writeFileSync(join(root, 'ui/host/src/mdx/controller.ts'), 'export {};');
    const manifest = { name: 'example', scripts: { preinstall: 'guard' }, dependencies: { '@itookit/core': 'workspace:*' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'ui/host/package.json'), JSON.stringify({ ...manifest, name: '@itookit/host', exports: { '.': './src/index.ts' } }));
    writeFileSync(join(root, 'ui/host/.env.local'), 'secret');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - ui/*\n  - libraries/*\noverrides:\n  "@itookit/core": "workspace:*"\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'development-lock');
    mkdirSync(join(root, 'patches'));
    writeFileSync(join(root, 'patches/legacy.patch'), 'unused historical patch');
    prepareRegistryWorkspace(root, destination, [{ name: '@itookit/core', version: '1.0.0' }]);
    assert.equal(existsSync(join(destination, 'libraries')), false);
    assert.equal(existsSync(join(destination, 'patches')), false);
    assert.doesNotMatch(readFileSync(join(destination, 'pnpm-workspace.yaml'), 'utf8'), /patchedDependencies/);
    assert.equal(existsSync(join(destination, 'ui/host/.env.local')), false);
    assert.equal(existsSync(join(destination, 'ui/host/src/mdx/controller.ts')), true);
    assert.equal(existsSync(join(destination, 'tools/image-tools/src/node.ts')), true);
    assert.equal(existsSync(join(destination, 'tools/image-tools/.env.local')), false);
    assert.equal(JSON.parse(readFileSync(join(destination, 'tools/image-tools/package.json'))).dependencies['@itookit/core'],'1.0.0');
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), 'development-lock');
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).dependencies['@itookit/core'], 'workspace:*');
    assert.equal(JSON.parse(readFileSync(join(destination, 'package.json'))).scripts.preinstall, undefined);
    assert.ok(workspaceAliases(join(destination, 'apps/web-app')).every(alias => !alias.find.test('@itookit/core')));
    assert.match(readFileSync(join(destination, 'pnpm-workspace.yaml'), 'utf8'), /"@itookit\/core": "1\.0\.0"/);
});


test('directory separation survives registry staging and independent UI libraries remain registry dependencies', t => {
    const root = mkdtempSync(join(tmpdir(), 'registry-separated-')), destination = join(root, 'release');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const catalog = [{ name: '@itookit/vfs-ui', version: '0.5.8', directory: 'vfs-ui' }];
    for (const [group, name] of [['ui', 'app-shell'], ['backend', 'app-core'], ['shared', 'app-contracts'], ['libraries', 'vfs-ui']]) {
        const dir = join(root, group, name);
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src/index.ts'), 'export {};');
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@itookit/' + name,
            exports: { '.': './src/index.ts' }, dependencies: { '@itookit/vfs-ui': 'workspace:*' } }));
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', scripts: {} }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - ui/*\n  - backend/*\n  - shared/*\n  - libraries/*\n');
    prepareRegistryWorkspace(root, destination, catalog);
    for (const directory of ['ui/app-shell', 'backend/app-core', 'shared/app-contracts']) {
        const manifest = JSON.parse(readFileSync(join(destination, directory, 'package.json')));
        assert.equal(manifest.dependencies['@itookit/vfs-ui'], '0.5.8');
        assert.equal('independent' in manifest, false);
    }
    assert.equal(existsSync(join(destination, 'libraries')), false);
    assert.equal(existsSync(join(destination, 'patches')), false);
    assert.doesNotMatch(readFileSync(join(destination, 'pnpm-workspace.yaml'), 'utf8'), /patchedDependencies/);
    assert.match(readFileSync(join(destination, 'pnpm-workspace.yaml'), 'utf8'), /ui\/\*/);
});
