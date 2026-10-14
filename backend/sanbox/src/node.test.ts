import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSandbox, probeSandbox } from './node';

const supported = process.platform === 'linux' || process.platform === 'darwin';
let root: string;
let writable: string;
let readonly: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sanbox-test-')));
    writable = join(root, 'rw');
    readonly = join(root, 'ro');
    mkdirSync(writable);
    mkdirSync(readonly);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!supported)('Node host preparation', () => {
    it('canonicalizes symlinks, freezes grants, and rejects cwd escaping through a symlink', () => {
        const alias = join(root, 'alias');
        symlinkSync(writable, alias);
        symlinkSync(readonly, join(writable, 'escape'));
        const policy = { writablePaths: [alias] };
        const sandbox = prepareSandbox(policy, '/bin/sh');
        policy.writablePaths.push(readonly);
        expect(sandbox.wrap({ command: 'true', cwd: alias }).cwd).toBe(writable);
        expect(() => sandbox.wrap({ command: 'true', cwd: join(writable, 'escape') })).toThrow('outside sandbox grants');
    });

    it('reports unavailable launchers and failed real startup without fallback', () => {
        expect(() => prepareSandbox({ writablePaths: [writable] }, join(root, 'missing'))).toThrow('unavailable');
        const sandbox = prepareSandbox({ writablePaths: [writable] }, '/usr/bin/false');
        expect(() => probeSandbox(sandbox, writable)).toThrow('Sandbox startup failed');
    });

    it('rejects missing directories and canonical grant conflicts', () => {
        expect(() => prepareSandbox({ writablePaths: [join(root, 'missing')] })).toThrow('unavailable');
        const alias = join(root, 'alias');
        symlinkSync(writable, alias);
        expect(() => prepareSandbox({ writablePaths: [writable], readOnlyPaths: [alias] })).toThrow('overlaps');
    });
});

// Explicit opt-in: namespace creation may be forbidden by an outer CI sandbox.
describe.skipIf(!supported || process.env.SANBOX_TEST_NATIVE !== '1')('native isolation', () => {
    it('permits granted writes, denies outside reads/writes, and confines child shells', () => {
        writeFileSync(join(readonly, 'input'), 'allowed');
        writeFileSync(join(root, 'secret'), 'outside');
        const sandbox = prepareSandbox({ writablePaths: [writable], readOnlyPaths: [readonly] });
        probeSandbox(sandbox, writable);
        const script = ['set -eu', 'cat "$1/input" > output',
            'if cat "$2/secret" 2>/dev/null; then exit 10; fi',
            'if echo denied > "$1/new" 2>/dev/null; then exit 11; fi',
            '/bin/sh -c \'if cat "$1/secret" 2>/dev/null; then exit 12; fi; if echo private > "$1/new" 2>/dev/null; then :; fi\' sh "$2"',
            'test -z "${SANBOX_HOST_SECRET-}"', 'cat output'].join('\n');
        const plan = sandbox.wrap({ command: '/bin/sh', args: ['-c', script, 'sh', readonly, root], cwd: writable });
        const result = spawnSync(plan.command, plan.args, { cwd: plan.cwd,
            env: { ...plan.env, SANBOX_HOST_SECRET: 'must-not-leak' }, encoding: 'utf8', timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('allowed');
        expect(readFileSync(join(writable, 'output'), 'utf8')).toBe('allowed');
        expect(existsSync(join(root, 'new'))).toBe(false);
        expect(existsSync(join(readonly, 'new'))).toBe(false);
    });

    it.skipIf(process.platform !== 'linux')('uses a separate network namespace unless explicitly allowed', () => {
        const host = readlinkSync('/proc/self/ns/net');
        for (const network of ['deny', 'allow'] as const) {
            const sandbox = prepareSandbox({ writablePaths: [writable], network });
            const plan = sandbox.wrap({ command: '/usr/bin/readlink', args: ['/proc/self/ns/net'], cwd: writable });
            const result = spawnSync(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, encoding: 'utf8', timeout: 10_000 });
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout.trim() === host).toBe(network === 'allow');
        }
    });
});
