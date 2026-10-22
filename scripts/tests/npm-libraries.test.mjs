import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseManifest, versions, libraries } from '../npm-libraries.mjs';
import { workspaceAliases } from '../workspace-sources.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('release manifests expose built entries and pin library dependencies', () => {
    const manifest = {name:'example',version:'old',main:'./src/index.ts',dependencies:{'@itookit/vfs-core':'workspace:*'},publishConfig:{main:'./dist/index.cjs',exports:{'.':'./dist/index.js'}}};
    const result = releaseManifest(manifest, '1.0.0');
    assert.equal(result.main, './dist/index.cjs');
    assert.equal(result.dependencies['@itookit/vfs-core'],versions.get('@itookit/vfs-core'));
    assert.equal(result.publishConfig,undefined);
    assert.equal(manifest.main,'./src/index.ts');
    assert.throws(() => releaseManifest({dependencies:{other:'workspace:*'}},'1.0.0'),/Non-registry dependency/);
});
test('Vite maps every independent workspace library to its public source entry in source mode', t => {
    const root = mkdtempSync(join(tmpdir(), 'library-source-aliases-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    for (const {name, directory} of libraries) {
        const pkg = join(root, 'libraries', directory); mkdirSync(join(pkg, 'src'), {recursive: true});
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({name, exports: {'.': './src/index.ts'}}));
        writeFileSync(join(pkg, 'src/index.ts'), '');
    }
    const aliases = workspaceAliases(join(root, 'apps/web-app'));
    for (const { name, directory } of libraries) {
        const alias = aliases.find(alias => alias.find.test(name));
        assert.ok(alias, name);
        assert.ok(alias.replacement.endsWith(`/libraries/${directory}/src/index.ts`));
    }
});
