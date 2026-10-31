import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installDependencies, isOfflineStoreMiss, missingOfflinePackages} from '../httpd-build.mjs';

const offlineMiss = `Scope: all 26 workspace projects
[ERROR] A package is missing from the store but cannot download it in offline mode. The missing package may be downloaded from https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.10.0.tgz.
[ERROR] A package is missing from the store but cannot download it in offline mode. The missing package may be downloaded from https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz.
Command failed: pnpm install --offline --ignore-scripts --no-frozen-lockfile`;

const recorded = () => {
    const calls = [];
    return {calls, runCommand: (command, args) => { calls.push([command, ...args]); return calls.length === 1 ? {status: 1, output: offlineMiss} : {status: 0, output: ''}; }};
};

test('offline store misses are recognized and named', () => {
    assert.equal(isOfflineStoreMiss(offlineMiss), true);
    assert.equal(isOfflineStoreMiss('ERR_PNPM_NO_OFFLINE_META Failed to resolve @xterm/addon-fit'), true);
    assert.equal(isOfflineStoreMiss('ELIFECYCLE Command failed with exit code 1'), false);
    assert.deepEqual(missingOfflinePackages(offlineMiss), ['@xterm/addon-fit', '@xterm/xterm']);
    assert.deepEqual(missingOfflinePackages('ERR_PNPM_NO_OFFLINE_META Failed to resolve @xterm/addon-fit@0.10.0 in package mirror /store'),
        ['@xterm/addon-fit@0.10.0']);
    assert.deepEqual(missingOfflinePackages('no registry links here'), []);
});

test('complete stores install offline without touching the network', () => {
    const calls = [];
    installDependencies('/tmp/source', {}, {log() {}, runCommand: (command, args) => { calls.push(args); return {status: 0, output: ''}; }});
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile']);
});

test('missing packages retry once with prefer-offline and report why', () => {
    const {calls, runCommand} = recorded(), logs = [];
    installDependencies('/tmp/source', {}, {operationId: 'op-1', log: message => logs.push(message), runCommand});
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('--prefer-offline'));
    assert.ok(!calls[1].includes('--offline'));
    assert.match(logs[0], /operationId=op-1 stage=install result=store-miss packages=@xterm\/addon-fit,@xterm\/xterm retry=prefer-offline/);
    assert.match(logs[1], /result=store-warmed packages=@xterm\/addon-fit,@xterm\/xterm/);
});

test('other install failures fail fast without a network retry', () => {
    let calls = 0;
    assert.throws(() => installDependencies('/tmp/source', {}, {
        log() {}, runCommand: () => { calls += 1; return {status: 1, output: 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"'} }
    }), error => error.code === 'HTTP_BUILD_INSTALL_FAILED');
    assert.equal(calls, 1);
});

test('a failed network retry reports the install failure code', () => {
    let calls = 0;
    const runCommand = () => { calls += 1; return calls === 1 ? {status: 1, output: offlineMiss} : {status: 1, output: 'registry unreachable'}; };
    assert.throws(() => installDependencies('/tmp/source', {}, {log() {}, runCommand}),
        error => error.code === 'HTTP_BUILD_INSTALL_FAILED' && /exited with code 1/.test(error.message));
    assert.equal(calls, 2);
});
