import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseManifest, versions, libraries } from '../npm-libraries.mjs';
import { workspaceAliases } from '../workspace-sources.mjs';

test('release manifests expose built entries and pin library dependencies', () => {
    const manifest = {name:'example',version:'old',main:'./src/index.ts',dependencies:{'@itookit/vfs-core':'workspace:*'},publishConfig:{main:'./dist/index.cjs',exports:{'.':'./dist/index.js'}}};
    const result = releaseManifest(manifest, '1.0.0');
    assert.equal(result.main, './dist/index.cjs');
    assert.equal(result.dependencies['@itookit/vfs-core'],versions.get('@itookit/vfs-core'));
    assert.equal(result.publishConfig,undefined);
    assert.equal(manifest.main,'./src/index.ts');
    assert.throws(() => releaseManifest({dependencies:{other:'workspace:*'}},'1.0.0'),/Non-registry dependency/);
});
test('Vite maps every independent workspace library to its public source entry', () => {
    const app = new URL('../../apps/web-app', import.meta.url).pathname;
    const aliases = workspaceAliases(app);
    for (const { name, directory } of libraries) {
        const alias = aliases.find(alias => alias.find.test(name));
        assert.ok(alias, name);
        assert.ok(alias.replacement.endsWith(`/libraries/${directory}/src/index.ts`));
    }
});
