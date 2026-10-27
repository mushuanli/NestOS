import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeDiagnostics } from '../src/diagnostics';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), 'cli-diagnostics-')); roots.push(root); return root; }
async function run(args: string[], root: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: path.resolve('.'), env: { ...process.env, NESTOS_DIAGNOSTICS_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
}
async function rows(root: string) {
    const file = (await readdir(root)).find(name => name.endsWith('.jsonl'))!;
    return (await readFile(path.join(root, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

it('logs nested failures, bounds messages and rotates persistent JSONL files', async () => {
    const root = await directory(), log = new RuntimeDiagnostics(root);
    const error = new AggregateError([new Error('locked', { cause: new Error('root/index.db') })], 'startup failed');
    log.record('bootstrap.failed', error);
    expect((await rows(root))[0].detail.message).toContain('root/index.db');
    const cycle = new Error('cycle'); cycle.cause = cycle; log.record('cycle', cycle);
    for (let index = 0; index < 1100; index++) log.record('bounded', 'x'.repeat(8000));
    expect(await readdir(root)).toHaveLength(2);
    const last = (await rows(root)).at(-1);
    expect(last.detail.message.length).toBeLessThanOrEqual(4000);
});

it('persists CLI startup failures and prints the log path without writing logs to stdout', async () => {
    const root = await directory();
    const result = await run(['src/cli.ts', 'validate', '-f', path.join(root, 'missing.yml'), '--offline', '--json'], root);
    const records = await rows(root);
    expect(result.code).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain(root);
    expect(records.map(row => row.event)).toContain('cli.failed');
    expect(JSON.stringify(records)).toContain('missing.yml');
    expect(records.at(-1)).toMatchObject({ event: 'process.exit' });
});

it.each(['throw new Error("fatal")', 'Promise.reject(new Error("rejected"))'])('preserves fatal exit semantics and records %s', async failure => {
    const root = await directory();
    const fixture = path.join(root, 'fatal.mjs');
    await writeFile(fixture, `import { installRuntimeDiagnostics } from ${JSON.stringify(path.resolve('src/diagnostics.ts'))}; installRuntimeDiagnostics(); ${failure};`);
    const result = await run([fixture], root);
    expect(result.code).toBe(1); expect(result.stderr).toContain(root);
    expect((await rows(root)).some(row => row.event === 'process.uncaughtException' || row.event === 'process.unhandledRejection')).toBe(true);
});


it('gives local, connected and hosted CLI diagnostics distinct mode filenames', async () => {
    const root = await directory();
    const files = ['cli-local', 'cli-remote', 'httpd-cli'].map(mode => new RuntimeDiagnostics(root, mode));
    for (const log of files) log.record('mode');
    expect(await readdir(root)).toHaveLength(3);
    expect(files.map(log => path.basename(log.file).split('-').slice(0, 2).join('-'))).toEqual(['cli-local', 'cli-remote', 'httpd-cli']);
});
