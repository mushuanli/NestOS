import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostArguments, runtimePaths, releaseDirectory, verifyRelease, runtimeLog, freezeWorkspaceDependencies, sourceFingerprint, copySource } from '../httpd-runtime.mjs';

test('captures source bytes independently and detects edits during a release build', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'httpd-source-'));
    try {
        const source = path.join(directory, 'source'), snapshot = path.join(directory, 'snapshot'); mkdirSync(source);
        execFileSync('git', ['init', '--quiet'], { cwd: source });
        writeFileSync(path.join(source, 'main.ts'), 'first'); writeFileSync(path.join(source, '.gitignore'), 'generated/\n');
        const fingerprint = sourceFingerprint(source); copySource(source, snapshot);
        mkdirSync(path.join(source, 'generated')); writeFileSync(path.join(source, 'generated/output.js'), 'ignored');
        assert.equal(sourceFingerprint(source), fingerprint);
        writeFileSync(path.join(source, 'main.ts'), 'second');
        assert.notEqual(sourceFingerprint(source), fingerprint); assert.equal(readFileSync(path.join(snapshot, 'main.ts'), 'utf8'), 'first');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release and development isolate logs, credentials, ports and development data', () => {
    const env = { XDG_CONFIG_HOME: '/tmp/mindos-config' };
    const release = runtimePaths('release', 'v1', env), development = runtimePaths('dev', 'working-tree', env);
    assert.notEqual(release.audit, development.audit); assert.notEqual(release.auth, development.auth);
    const dev = hostArguments('dev', 'working-tree', [], env), prod = hostArguments('release', 'v1', [], env);
    assert.equal(dev[dev.indexOf('--port') + 1], '2001');
    assert.equal(dev[dev.indexOf('--root') + 1], development.developmentRoot);
    assert.ok(!prod.includes('--root')); assert.ok(!prod.includes('--port'));
    const overridden = hostArguments('dev', 'working-tree', ['--port=3000', '--root', '/tmp/explicit'], env);
    assert.equal(overridden.filter(value => value.startsWith('--port')).length, 1);
    assert.equal(overridden.filter(value => value === '--root').length, 1);
});
test('rejects modified release bytes and path traversal before startup', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'httpd-manifest-'));
    try {
        writeFileSync(path.join(directory, 'server.js'), 'original');
        writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ nodeMajor: Number(process.versions.node.split('.')[0]),
            files: [{ file: 'server.js', sha256: createHash('sha256').update('original').digest('hex') }] }));
        assert.ok(verifyRelease(directory)); writeFileSync(path.join(directory, 'server.js'), 'development edit');
        assert.throws(() => verifyRelease(directory), /changed/);
        for (const id of ['../escape', '/absolute', '..', 'a/b']) assert.throws(() => releaseDirectory(directory, id));
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('freezes workspace links to the deployment copy rather than the development tree', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'httpd-dependencies-'));
    try {
        const source = path.join(directory, 'source'), snapshot = path.join(directory, 'snapshot');
        const nested = path.join(snapshot, 'node_modules/.pnpm/parent/node_modules/@itookit');
        const copied = path.join(snapshot, 'node_modules/.pnpm/pkg/node_modules/@itookit/core');
        mkdirSync(source, { recursive: true }); mkdirSync(nested, { recursive: true }); mkdirSync(copied, { recursive: true });
        writeFileSync(path.join(snapshot, 'package.json'), JSON.stringify({ name: '@itookit/http-app', version: '1' }));
        for (const where of [source, copied]) {
            writeFileSync(path.join(where, 'package.json'), JSON.stringify({ name: '@itookit/core', version: '1' }));
            writeFileSync(path.join(where, 'index.js'), 'snapshot');
        }
        const link = path.join(nested, 'core'); symlinkSync(source, link, 'dir'); freezeWorkspaceDependencies(snapshot);
        assert.equal(realpathSync(link), copied); writeFileSync(path.join(source, 'index.js'), 'development edit');
        assert.equal(readFileSync(path.join(link, 'index.js'), 'utf8'), 'snapshot');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('bounds runtime log rotation and protects the log file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'httpd-output-'));
    try {
        const file = path.join(directory, 'runtime.log'), log = runtimeLog(file, 16);
        for (let index = 0; index < 12; index++) log.write(Buffer.from('output\n'));
        log.close();
        assert.ok(statSync(file).size <= 16); assert.ok(statSync(file + '.3').size <= 16);
        assert.equal(statSync(file).mode & 0o077, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
