import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { hostArguments, hostEnvironment, runtimePaths, releaseDirectory, verifyRelease, runtimeLog, freezeWorkspaceDependencies, sourceFingerprint, copySource, copyNativeRuntimes } from '../httpd-runtime.mjs';

test('deployment retains native runtime files and rejects incompatible package builds', t => {
    const root = mkdtempSync(path.join(tmpdir(), 'httpd-native-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const source = path.join(root, 'source'), destination = path.join(root, 'deployment');
    for (const directory of [source, destination]) {
        const pkg = path.join(directory, 'node_modules/addon'); mkdirSync(pkg, {recursive: true});
        writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name: 'addon', version: '1.0.0'}));
    }
    const built = path.join(source, 'node_modules/addon/build/Release');
    mkdirSync(path.join(built, 'obj.target'), {recursive: true});
    writeFileSync(path.join(built, 'addon.node'), 'compiled native runtime');
    writeFileSync(path.join(built, 'obj.target/intermediate.o'), 'build-only');
    copyNativeRuntimes(source, destination, ['addon']);
    const installed = path.join(destination, 'node_modules/addon');
    assert.equal(readFileSync(path.join(installed, 'build/Release/addon.node'), 'utf8'), 'compiled native runtime');
    assert.equal(existsSync(path.join(installed, 'build/Release/obj.target')), false);
    writeFileSync(path.join(installed, 'package.json'), JSON.stringify({name: 'addon', version: '2.0.0'}));
    assert.throws(() => copyNativeRuntimes(source, destination, ['addon']), /NATIVE_RUNTIME_VERSION_MISMATCH.*installed=1.0.0 deployed=2.0.0/);
});

test('inherits proxy settings and honors explicit activation or opt-out without changing the parent', () => {
    for (const name of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
        const env = { [name]: 'http://127.0.0.1:7890', no_proxy: 'localhost,192.168.31.10' };
        assert.deepEqual(hostEnvironment(env), { ...env, NODE_USE_ENV_PROXY: '1' });
        assert.equal(env.NODE_USE_ENV_PROXY, undefined);
        for (const value of ['0', '1']) assert.equal(hostEnvironment({ ...env, NODE_USE_ENV_PROXY: value }).NODE_USE_ENV_PROXY, value);
    }
    assert.deepEqual(hostEnvironment({ no_proxy: 'localhost', http_proxy: '' }), { no_proxy: 'localhost', http_proxy: '' });
});

test('Node fetch uses the inherited lowercase proxy and bypasses it for no_proxy', async () => {
    const requests = [];
    const proxy = createServer((request, response) => { requests.push(request.url); response.end('proxied'); });
    const target = createServer((_request, response) => response.end('direct'));
    await Promise.all([proxy, target].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    try {
        const env = { http_proxy: `http://127.0.0.1:${proxy.address().port}` };
        const url = `http://127.0.0.1:${target.address().port}/proxy-check`;
        const run = overrides => promisify(execFile)(process.execPath,
            ['-e', 'fetch(process.argv[1]).then(r => r.text()).then(console.log)', url],
            { env: hostEnvironment({ ...env, ...overrides }), timeout: 10_000 });
        assert.equal((await run({})).stdout.trim(), 'proxied');
        assert.deepEqual(requests, [url]);
        assert.equal((await run({ no_proxy: '127.0.0.1' })).stdout.trim(), 'direct');
        assert.equal((await run({ NODE_USE_ENV_PROXY: '0' })).stdout.trim(), 'direct');
        assert.deepEqual(requests, [url]);
    } finally {
        await Promise.all([proxy, target].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    }
});

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
    const release = runtimePaths('release', env), development = runtimePaths('dev', env);
    assert.equal(release.runtime, '/var/log/mindos/httpd.runtime.log');
    assert.equal(release.audit, '/var/log/mindos/httpd.audit.jsonl');
    assert.equal(development.runtime, '/var/log/mindos/httpd.debug.runtime.log');
    assert.equal(development.audit, '/var/log/mindos/httpd.debug.audit.jsonl');
    assert.notEqual(release.audit, development.audit); assert.notEqual(release.auth, development.auth);
    const dev = hostArguments('dev', [], env), prod = hostArguments('release', [], env);
    assert.equal(dev[dev.indexOf('--port') + 1], '2001');
    assert.equal(dev[dev.indexOf('--root') + 1], development.developmentRoot);
    assert.ok(!prod.includes('--root')); assert.ok(!prod.includes('--port'));
    const overridden = hostArguments('dev', ['--port=3000', '--root', '/tmp/explicit'], env);
    assert.equal(overridden.filter(value => value.startsWith('--port')).length, 1);
    assert.equal(overridden.filter(value => value === '--root').length, 1);
});
test('redirects both httpd logs without moving config and preserves an explicit audit file', () => {
    const env = { XDG_CONFIG_HOME: '/tmp/mindos-config', MINDOS_HTTPD_LOG_DIR: '/tmp/mindos-logs' };
    for (const mode of ['release', 'dev']) {
        const paths = runtimePaths(mode, env), defaults = runtimePaths(mode, { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME });
        assert.equal(paths.logs, env.MINDOS_HTTPD_LOG_DIR);
        assert.equal(path.dirname(paths.runtime), paths.logs); assert.equal(path.dirname(paths.audit), paths.logs);
        assert.equal(paths.auth, defaults.auth); assert.equal(paths.config, defaults.config);
        const args = hostArguments(mode, [], env);
        assert.equal(args[args.indexOf('--audit-file') + 1], paths.audit);
        for (const explicit of [['--audit-file', '/tmp/custom.jsonl'], ['--audit-file=/tmp/custom.jsonl']]) {
            const overridden = hostArguments(mode, explicit, env);
            assert.equal(overridden.filter(value => value.startsWith('--audit-file')).length, 1);
            assert.deepEqual(overridden.slice(0, explicit.length), explicit);
        }
    }
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
