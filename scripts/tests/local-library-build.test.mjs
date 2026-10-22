import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import state from '../local-library-state.cjs';
import { preparedSnapshot } from '../local-library-plan.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'incremental-libraries-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
    const catalog = ['core', 'parent', 'leaf', 'other'].map(directory => ({ name: `@itookit/${directory}`, directory, version: '1.0.0' }));
    writeFileSync(join(root, 'scripts/npm-libraries.json'), JSON.stringify(catalog));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'build-fixture', private: true, packageManager: 'pnpm@10.20.0' }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - libraries/*\noverrides:\n' + catalog.map(item => `  "${item.name}": "workspace:*"`).join('\n') + '\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    writeFileSync(join(root, 'tsconfig.base.json'), '{}');
    for (const item of catalog) createLibrary(root, item, { parent: 'core', leaf: 'parent' }[item.directory]);
    return root;
}
function createLibrary(root, item, dependency) {
    const directory = join(root, 'libraries', item.directory); mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: item.name, version: item.version,
        exports: { '.': './src/index.cjs' }, publishConfig: { exports: { '.': './dist/index.cjs' } },
        files: ['dist'], scripts: { build: 'node build.cjs' }, ...(dependency && { dependencies: { [`@itookit/${dependency}`]: '1.0.0' } }) }));
    writeFileSync(join(directory, 'src/index.cjs'), dependency ? `module.exports=require('@itookit/${dependency}');` : 'module.exports={value:1};');
    writeFileSync(join(directory, 'build.cjs'), `const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.copyFileSync('src/index.cjs','dist/index.cjs');
const value=${dependency ? `require('@itookit/${dependency}').value` : `require('./src/index.cjs').value`};
fs.appendFileSync(process.env.BUILD_LOG, '${item.directory}:'+value+'\\n');`);
}
function build(root, library) {
    return spawnSync(process.execPath, ['scripts/local-libraries.mjs', 'build', ...(library ? [library] : [])], {
        cwd: root, encoding: 'utf8', env: { ...process.env, MINDOS_LIBRARY_SNAPSHOT: '', BUILD_LOG: join(root, 'build.log') }, timeout: 60_000,
    });
}
const lines = root => readFileSync(join(root, 'build.log'), 'utf8').trim().split('\n');

test('incremental builds reuse artifacts, rebuild dependents, and freeze unselected dirty sources', t => {
    const root = fixture(t);
    let result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    const first = preparedSnapshot(root);
    assert.equal(lines(root).length, 4);
    assert.equal(state.readSelection(root), null, 'building must not activate dependencies');
    result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(preparedSnapshot(root).id, first.id); assert.equal(lines(root).length, 4);
    writeFileSync(join(root, 'libraries/core/src/index.cjs'), 'module.exports={value:2};');
    result = build(root); assert.equal(result.status, 0, result.stdout + result.stderr);
    const second = preparedSnapshot(root);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(lines(root).slice(4), ['core:2', 'parent:2', 'leaf:2']);
    assert.equal(second.packages.find(item => item.directory === 'other').sha256, first.packages.find(item => item.directory === 'other').sha256);
    writeFileSync(join(root, 'libraries/core/src/index.cjs'), 'module.exports={value:3};');
    writeFileSync(join(root, 'libraries/other/package.json'), 'unfinished unrelated manifest');
    result = build(root, '@itookit/parent'); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(lines(root).slice(7), ['parent:2', 'leaf:2']);
    const third = preparedSnapshot(root);
    assert.equal(third.packages.find(item => item.directory === 'core').sha256, second.packages.find(item => item.directory === 'core').sha256);
    result = build(root, 'not-a-library'); assert.equal(result.status, 1);
    assert.match(result.stderr, /LOCAL_LIBRARIES_UNKNOWN/);
    result = build(root); assert.equal(result.status, 1);
    assert.equal(preparedSnapshot(root).id, third.id, 'failed builds must retain the usable prepared snapshot');
    assert.equal(existsSync(state.activeFile(root)), false);
});
