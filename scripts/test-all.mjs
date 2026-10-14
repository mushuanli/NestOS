#!/usr/bin/env node
// Run package suites sequentially; keep real CLI crash tests in a separate process.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const steps = [
    ['package suites', ['-r', '--workspace-concurrency=1', '--filter', '!@itookit/cli', 'test']],
    // Source consumers launch real CLI processes; run files serially to avoid lease/timeout contention.
    ['CLI suites (no crash matrix)', ['--filter', '@itookit/cli', 'exec', 'vitest', 'run', '--fileParallelism=false', '--exclude', 'tests/crash-matrix.test.ts']],
    ['CLI crash matrix', ['--filter', '@itookit/cli', 'exec', 'vitest', 'run', 'tests/crash-matrix.test.ts']],
    ['Rust sandbox boundaries', ['--filter', 'tauri-app', 'test:rust']],
];

function run(args) {
    return new Promise(resolve => {
        const child = spawn('pnpm', args, { cwd, stdio: 'inherit' });
        child.once('error', error => {
            process.stderr.write(`Cannot start pnpm: ${error.message}\n`);
            resolve(1);
        });
        child.once('close', code => resolve(code ?? 1));
    });
}

for (const [label, args] of steps) {
    process.stdout.write(`\n=== ${label}: pnpm ${args.join(' ')}\n`);
    const code = await run(args);
    if (code !== 0) {
        process.stderr.write(`\n=== ${label} failed (exit ${code}); stopping the matrix\n`);
        process.exit(code);
    }
}
process.stdout.write('\n=== configured test matrix passed\n');
