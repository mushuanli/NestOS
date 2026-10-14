import { fork, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/workspace-crash-host.ts', import.meta.url));
function child(root: string, phase: string): Promise<{ code: number | null; signal: string | null; reached: boolean }> {
    return new Promise((resolve, reject) => {
        const process = fork(fixture, [root, phase], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let reached = false, stderr = '', timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; process.kill('SIGKILL'); }, 20_000);
        process.stdout?.resume(); process.stderr?.on('data', data => { stderr += data; });
        process.on('message', (message: any) => { if (message.point === phase) { reached = true; process.kill('SIGKILL'); } });
        process.on('error', error => { clearTimeout(timeout); reject(error); });
        process.on('exit', (code, signal) => {
            clearTimeout(timeout);
            if (timedOut) reject(new Error(`Host timeout: ${stderr}`));
            else if (code !== 0 && !reached) reject(new Error(`Host failed: ${code}: ${stderr}`));
            else resolve({ code, signal, reached });
        });
    });
}

it.each(['intent', 'created', 'published'])('recovers workspace ownership after SIGKILL at %s', async phase => {
    const root = await mkdtemp(join(tmpdir(), 'tauri-workspace-crash-'));
    const repository = join(root, 'repository'); await mkdir(repository);
    const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0); return result.stdout;
    };
    try {
        git(['init', '-q']);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial']);
        expect(await child(root, phase)).toEqual({ code: null, signal: 'SIGKILL', reached: true });
        const intentRoot = join(root, 'var/lib/worktrees/.intents');
        const names = await readdir(intentRoot); expect(names).toHaveLength(1);
        const saved = JSON.parse(await readFile(join(intentRoot, names[0]), 'utf8'));
        expect(git(['worktree', 'list', '--porcelain']).includes(saved.directory)).toBe(phase !== 'intent');
        expect((await child(root, phase === 'published' ? 'recover-published' : 'recover')).code).toBe(0);
        if (phase === 'published') expect(JSON.parse(await readFile(join(root, 'retained.json'), 'utf8')).directory).toBe(saved.directory);
        if (phase === 'published') expect(JSON.parse(await readFile(join(root, 'completed.json'), 'utf8'))).toEqual({
            status: 'succeeded', workspace: { status: 'succeeded' },
        });
        expect(await readdir(intentRoot)).toEqual([]);
        expect(git(['worktree', 'list', '--porcelain'])).not.toContain(saved.directory);
        expect(git(['branch', '--list', saved.git.branch]).trim()).toBe('');
    } finally { await rm(root, { recursive: true, force: true }); }
});
