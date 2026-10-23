import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {acquireBuildLock, artifactContext, buildEnvironment, dependencyInputs, graphInputs, restoreArtifact, storeArtifact} from '../httpd-build-cache.mjs';

function fixture(t) {
    const root = mkdtempSync(path.join(tmpdir(), 'httpd-cache-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const source = path.join(root, 'source'), output = path.join(root, 'output'), cache = path.join(root, 'cache');
    mkdirSync(source); mkdirSync(output);
    for (const file of ['ui.ts', 'server.ts', 'package.json']) writeFileSync(path.join(source, file), file);
    writeFileSync(path.join(output, 'app.js'), 'compiled');
    const files = ['package.json', 'server.ts', 'ui.ts'];
    const context = () => artifactContext(source, files, 'dependencies', {});
    storeArtifact(cache, output, source, context(), ['ui.ts']);
    const restore = () => restoreArtifact(cache, path.join(root, 'restored'), source, context());
    return {root, source, output, cache, context, files, restore};
}

test('artifact reuse tracks actual compiler inputs and preserves independent outputs', t => {
    const f = fixture(t);
    writeFileSync(path.join(f.source, 'server.ts'), 'backend-only change');
    assert.equal(f.restore().hit, true);
    assert.notEqual(statSync(path.join(f.root, 'restored/app.js')).ino, statSync(path.join(f.cache, 'output/app.js')).ino);
    writeFileSync(path.join(f.root, 'restored/app.js'), 'changed release');
    assert.equal(readFileSync(path.join(f.cache, 'output/app.js'), 'utf8'), 'compiled');
    writeFileSync(path.join(f.source, 'ui.ts'), 'frontend change');
    assert.equal(f.restore().reason, 'input-changed');
});

test('configuration, new glob candidates and environment invalidate artifacts', t => {
    const f = fixture(t), original = f.context();
    f.files.push('new.ts'); writeFileSync(path.join(f.source, 'new.ts'), 'new import candidate');
    assert.notEqual(f.context(), original);
    f.files.pop(); writeFileSync(path.join(f.source, 'package.json'), 'changed');
    assert.notEqual(f.context(), original);
    assert.notEqual(artifactContext(f.source, f.files, 'dependencies', buildEnvironment({VITE_API: 'a'})),
        artifactContext(f.source, f.files, 'dependencies', buildEnvironment({VITE_API: 'b'})));
    assert.deepEqual(dependencyInputs(['ui.ts', 'a/package.json', 'pnpm-lock.yaml', 'scripts/local-library-state.mjs']),
        ['a/package.json', 'pnpm-lock.yaml', 'scripts/local-library-state.mjs']);
});

test('corrupt outputs and receipts fail closed and a failed store preserves previous cache', t => {
    const f = fixture(t);
    writeFileSync(path.join(f.cache, 'output/app.js'), 'corruption');
    assert.equal(f.restore().reason, 'output-changed');
    storeArtifact(f.cache, f.output, f.source, f.context(), ['ui.ts']);
    const bad = path.join(f.root, 'bad'); mkdirSync(bad); symlinkSync(path.join(f.output, 'app.js'), path.join(bad, 'linked.js'));
    assert.throws(() => storeArtifact(f.cache, bad, f.source, f.context(), ['ui.ts']), /OUTPUT_SYMLINK/);
    assert.equal(f.restore().hit, true);
    const receipt = JSON.parse(readFileSync(path.join(f.cache, 'cache.json'), 'utf8'));
    receipt.inputs[0].file = '../outside';
    writeFileSync(path.join(f.cache, 'cache.json'), JSON.stringify(receipt));
    assert.equal(f.restore().reason, 'input-changed');
    writeFileSync(path.join(f.cache, 'cache.json'), '{');
    assert.equal(f.restore().reason, 'invalid-cache');
});

test('compiler graph strips query IDs, excludes installed libraries and rejects external inputs', t => {
    const f = fixture(t), installed = path.join(f.source, 'node_modules/lib');
    mkdirSync(installed, {recursive: true}); writeFileSync(path.join(installed, 'index.js'), 'library');
    assert.deepEqual(graphInputs(f.source, [path.join(f.source, 'ui.ts') + '?raw', path.join(installed, 'index.js'), '\0virtual']), ['ui.ts']);
    assert.throws(() => graphInputs(f.source, [path.join(f.output, 'app.js')]), /OUTSIDE_CAPTURE/);
});

test('build lock protects stable capture from concurrent mutation and releases after failure', t => {
    const f = fixture(t), unlock = acquireBuildLock(f.root);
    try { assert.throws(() => acquireBuildLock(f.root), /HTTP_BUILD_BUSY/); }
    finally { unlock(); }
    acquireBuildLock(f.root)();
});
