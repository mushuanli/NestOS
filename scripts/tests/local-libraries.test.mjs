import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import state from '../local-library-state.cjs';
import { checkWorkspace } from '../check-workspace.mjs';
import { workspaceAliases } from '../workspace-sources.mjs';
import { copyLibrarySnapshot, pinSnapshotDependencies, freezeWorkspaceDependencies, sourceFiles, sourceFingerprint } from '../httpd-runtime.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const catalog = ['core', 'parent'].map(directory => ({ name: `@itookit/${directory}`, directory, version: '1.0.0' }));
function write(file, value) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'local-libraries-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(join(repository, '.pnpmfile.cjs'), join(root, '.pnpmfile.cjs'));
    cpSync(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
    write(join(root, 'scripts/npm-libraries.json'), catalog);
    write(join(root, 'package.json'), { name: 'fixture', private: true });
    write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - libraries/*\n  - ui/*\noverrides:\n  "@itookit/core": "workspace:*"\n  "@itookit/parent": "workspace:*"\n');
    for (const item of catalog) {
        const directory = join(root, 'libraries', item.directory);
        write(join(directory, 'package.json'), { name: item.name, version: item.version, exports: { '.': './src/index.cjs' } });
        write(join(directory, 'src/index.cjs'), 'module.exports = {value:"live source"};');
    }
    write(join(root, 'ui/consumer/package.json'), { name: '@itookit/consumer', exports: { '.': './src/index.cjs' },
        dependencies: { '@itookit/core': 'workspace:*', '@itookit/parent': 'workspace:*' } });
    write(join(root, 'ui/consumer/src/index.cjs'), 'module.exports = require("@itookit/core");');
    return root;
}
function snapshotAt(root, value = 'snapshot') {
    const output = join(root, 'packing'); mkdirSync(output, { recursive: true });
    const packages = catalog.map(item => {
        const staging = join(output, item.directory); mkdirSync(join(staging, 'dist'), { recursive: true });
        write(join(staging, 'package.json'), { name: item.name, version: item.version, exports: { '.': './dist/index.cjs', './style.css': './dist/style.css' },
            ...(item.directory === 'parent' && { dependencies: { '@itookit/core': '1.0.0' }, peerDependencies: { '@itookit/core': '^1.0.0' } }) });
        write(join(staging, 'dist/index.cjs'), item.directory === 'core' ? `module.exports = {value:${JSON.stringify(value)}};` : 'module.exports = require("@itookit/core");');
        write(join(staging, 'dist/style.css'), 'body {}');
        execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { cwd: staging, stdio: 'pipe' });
        const tarball = readFileSync(join(output, `itookit-${item.directory}-1.0.0.tgz`));
        const sha256 = createHash('sha256').update(tarball).digest('hex'), file = `packages/${item.directory}.tgz`;
        return { ...item, file, sha256, tarball };
    });
    const records = packages.map(({ tarball, ...item }) => item), id = state.snapshotIdentity(records);
    const directory = join(state.localRoot(root), 'snapshots', id);
    mkdirSync(join(directory, 'packages'), { recursive: true });
    for (const item of packages) writeFileSync(join(directory, item.file), item.tarball);
    write(join(directory, 'snapshot.json'), { format: 1, id, packages: records });
    return state.readSnapshot(root, id);
}
function install(root, choice) {
    return spawnSync('pnpm', ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true', MINDOS_LIBRARY_SNAPSHOT: choice }, timeout: 30_000,
    });
}
function runConsumer(root) {
    return JSON.parse(execFileSync(process.execPath, ['-e', 'const a=require("@itookit/core"),b=require("@itookit/parent");console.log(JSON.stringify({value:a.value,same:a===b,css:require.resolve("@itookit/core/style.css"),path:require.resolve("@itookit/core")}));'], {
        cwd: join(root, 'ui/consumer'), encoding: 'utf8',
    }));
}

test('snapshots validate identities, completeness, safe paths and artifact bytes before use', t => {
    const root = fixture(t), snapshot = snapshotAt(root), file = join(snapshot.directory, 'snapshot.json');
    assert.equal(state.readSelection(root), null);
    assert.equal(state.readSelection(root, snapshot.id).id, snapshot.id);
    assert.throws(() => state.readSelection(root, '../escape'), /LOCAL_LIBRARIES_ID/);
    write(file, { ...snapshot, packages: snapshot.packages.slice(1) });
    assert.throws(() => state.readSnapshot(root, snapshot.id), /LOCAL_LIBRARIES_IDENTITY/);
    write(file, { format: 1, id: snapshot.id, packages: snapshot.packages });
    write(join(snapshot.directory, snapshot.packages[0].file), 'corrupt');
    assert.throws(() => state.readSelection(root, snapshot.id), /LOCAL_LIBRARIES_INTEGRITY/);
});

test('real pnpm installs immutable artifacts for direct, transitive and peer dependencies, including same-version refresh', t => {
    const root = fixture(t), first = snapshotAt(root);
    write(join(root, 'pnpm-lock.yaml'), 'source-lock-sentinel');
    let result = install(root, first.id);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    write(state.activeFile(root), { format: 1, mode: 'snapshot', id: first.id });
    const installed = runConsumer(root);
    assert.equal(installed.value, 'snapshot'); assert.equal(installed.same, true);
    assert.ok(realpathSync(installed.path).startsWith(first.virtualStoreDir + '/'));
    assert.ok(installed.css.endsWith('/dist/style.css'));
    assert.deepEqual(checkWorkspace(root, { catalog, installed: true }), []);
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), 'source-lock-sentinel');
    write(join(root, 'libraries/core/src/index.cjs'), 'throw new Error("unfinished library edit");');
    assert.equal(runConsumer(root).value, 'snapshot');
    write(join(root, 'libraries/core/package.json'), 'unfinished manifest');
    assert.deepEqual(checkWorkspace(root, {catalog, installed: true}), []);
    result = install(root, first.id);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(workspaceAliases(join(root, 'apps/web-app')).every(alias => !alias.find.test('@itookit/core')));
    assert.ok(workspaceAliases(join(root, 'apps/web-app')).some(alias => alias.find.test('@itookit/consumer')));
    const second = snapshotAt(root, 'updated snapshot');
    assert.notEqual(first.id, second.id);
    assert.equal(state.readSelection(root).id, first.id, 'preparation never activates');
    result = install(root, second.id);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(runConsumer(root).value, 'updated snapshot');
    assert.ok(checkWorkspace(root, { catalog, installed: true, snapshot: first }).some(error => error.includes('outside selected snapshot')));
    rmSync(join(root, 'libraries'), { recursive: true });
    assert.deepEqual(checkWorkspace(root, { catalog, snapshot: second, installed: true }), []);
});

test('explicit source restoration returns to workspace links and preserves the source lockfile', t => {
    const root = fixture(t);
    const initial = install(root, 'source'); assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), snapshot = snapshotAt(root);
    const execute = args => spawnSync(process.execPath, ['scripts/local-libraries.mjs', ...args], {
        cwd: root, encoding: 'utf8', env: {...process.env, CI: 'true', MINDOS_LIBRARY_SNAPSHOT: ''}, timeout: 30_000,
    });
    const enabled = execute(['use', snapshot.id]); assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
    assert.equal(state.readSelection(root).id, snapshot.id);
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lock);
    const restored = execute(['source']); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.equal(state.readSelection(root), null);
    assert.equal(realpathSync(join(root, 'ui/consumer/node_modules/@itookit/core')), join(root, 'libraries/core'));
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lock);
});

test('failed activation restores the previous installation and never publishes the candidate selector', t => {
    const root = fixture(t), previous = snapshotAt(root), candidate = snapshotAt(root, 'candidate');
    let result = install(root, previous.id); assert.equal(result.status, 0, result.stderr);
    write(state.activeFile(root), { format: 1, mode: 'snapshot', id: previous.id });
    const bin = join(root, 'bin'); mkdirSync(bin);
    const pnpm = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nif [ "$MINDOS_LIBRARY_SNAPSHOT" = "${candidate.id}" ]; then echo "FIXTURE_INSTALL_FAILURE" >&2; exit 9; fi\nexec '${pnpm}' "$@"\n`, { mode: 0o755 });
    result = spawnSync(process.execPath, ['scripts/local-libraries.mjs', 'use', candidate.id], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, CI: 'true', MINDOS_LIBRARY_SNAPSHOT: '' }, timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /FIXTURE_INSTALL_FAILURE/);
    assert.match(result.stdout, /stage=rollback result=success/);
    assert.equal(state.readSelection(root).id, previous.id);
    assert.equal(runConsumer(root).value, 'snapshot');
    assert.equal(existsSync(join(state.localRoot(root), 'operation.lock')), false);
});

test('production deployment resolves peer-only libraries from local artifacts without registry access', t => {
    const root = fixture(t), snapshot = snapshotAt(root), destination = join(root, 'deployment');
    write(join(root, 'ui/peer/package.json'), {name: '@itookit/peer', version: '1.0.0', exports: {'.': './src/index.cjs'}, peerDependencies: {'@itookit/parent': 'workspace:*'}});
    write(join(root, 'ui/peer/src/index.cjs'), 'module.exports = require("@itookit/parent");');
    write(join(root, 'ui/consumer/package.json'), {name: '@itookit/consumer', version: '1.0.0', exports: {'.': './src/index.cjs'}, dependencies: {'@itookit/peer': 'workspace:*', '@itookit/core': 'workspace:*'}});
    pinSnapshotDependencies(join(root, 'ui/consumer/package.json'), snapshot);
    write(state.activeFile(root), {format: 1, mode: 'snapshot', id: snapshot.id});
    rmSync(join(root, 'libraries'), {recursive: true});
    const installed = spawnSync('pnpm', ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], {
        cwd: root, encoding: 'utf8', env: {...process.env, CI: 'true', MINDOS_LIBRARY_SNAPSHOT: snapshot.id, MINDOS_LIBRARY_DEPLOYMENT: '1'}, timeout: 30_000,
    });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const deployed = spawnSync('pnpm', ['--config.offline=true', '--ignore-scripts', '--filter', '@itookit/consumer', 'deploy', '--prod', '--legacy', destination], {
        cwd: root, encoding: 'utf8', env: {...process.env, CI: 'true', MINDOS_LIBRARY_SNAPSHOT: snapshot.id, MINDOS_LIBRARY_DEPLOYMENT: '1'}, timeout: 30_000,
    });
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    freezeWorkspaceDependencies(destination);
    rmSync(join(root, 'ui'), {recursive: true});
    rmSync(join(state.localRoot(root), 'snapshots'), {recursive: true});
    const result = execFileSync(process.execPath, ['-e', 'console.log(require("@itookit/peer").value)'], {cwd: destination, encoding: 'utf8'});
    assert.equal(result.trim(), 'snapshot');
});

test('HTTP capture carries the exact snapshot and ignores ongoing library source edits', t => {
    const root = fixture(t), snapshot = snapshotAt(root), destination = join(root, 'capture');
    write(state.activeFile(root), { format: 1, mode: 'snapshot', id: snapshot.id });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    write(join(root, '.gitignore'), 'release/\npacking/\ncapture/\n');
    const before = sourceFingerprint(root);
    assert.ok(sourceFiles(root).every(file => !file.startsWith('libraries/')));
    write(join(root, 'libraries/core/src/index.cjs'), 'incomplete edit');
    assert.equal(sourceFingerprint(root), before);
    copyLibrarySnapshot(root, destination);
    assert.equal(state.readSelection(destination).id, snapshot.id);
    assert.equal(existsSync(join(destination, 'libraries')), false);
});
