import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = join(root, 'scripts/test-all.mjs');
function execute(t, failAt, missing = false) {
    const dir = mkdtempSync(join(tmpdir(), 'test-matrix-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, 'calls.jsonl');
    if (!missing) writeFileSync(join(dir, 'pnpm'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.MATRIX_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
process.exit(args.includes(process.env.MATRIX_FAIL) ? 7 : 0);
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [runner], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, PATH: dir, MATRIX_LOG: log, MATRIX_FAIL: failAt ?? '' },
    });
    const calls = missing ? [] : readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    return { result, calls };
}

test('runs every stage from the repository and isolates CLI crashes', t => {
    const { result, calls } = execute(t);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.cwd === root.replace(/\/$/, '')));
    assert.ok(calls[0].args.includes('--workspace-concurrency=1'));
    assert.ok(calls[0].args.includes('!@itookit/cli'));
    assert.ok(calls[1].args.includes('--exclude'));
    assert.ok(calls[1].args.includes('--fileParallelism=false'));
    assert.equal(calls[1].args.at(-1), 'tests/crash-matrix.test.ts');
    assert.equal(calls[2].args.at(-1), 'tests/crash-matrix.test.ts');
    assert.ok(!calls[2].args.includes('--exclude'));
    assert.equal(calls[3].args.at(-1), 'test:rust');
});

test('preserves failing exit status and never starts later stages', t => {
    const { result, calls } = execute(t, '--exclude');
    assert.equal(result.status, 7);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(result.stdout, /matrix passed/);
});

test('missing package manager fails explicitly without reporting success', t => {
    const { result } = execute(t, undefined, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot start pnpm:/);
    assert.doesNotMatch(result.stdout, /matrix passed/);
});
