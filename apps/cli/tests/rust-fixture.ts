// @file: apps/cli/tests/rust-fixture.ts
// Compiles the Tauri Session Bash fixture that `tauri-process-tree` and `nested-harness` use as
// real-machine evidence. The fixture includes `session_bash.rs`, which links the sandbox crate, so
// a bare `rustc` cannot resolve `itookit_sanbox`: build that crate with cargo first and pass the
// resulting rlib explicitly. This keeps the suites on the real module instead of a stub.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No trailing separator: the sandbox validates mount sources as Session Bash paths and rejects
// `/repo/` even though the rest of the suite happily concatenates it.
export const repo = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

const run = (file: string, args: string[], cwd: string): Promise<void> =>
    new Promise((resolve, reject) => {
        execFile(file, args, { cwd, timeout: 600_000, maxBuffer: 4_000_000 },
            error => error ? reject(error) : resolve());
    });

export async function compileSessionBashFixture(binary: string): Promise<void> {
    const crate = join(repo, 'backend/sanbox/native'), target = join(crate, 'target/debug');
    const rlib = join(target, 'libitookit_sanbox.rlib');
    if (!existsSync(rlib)) await run('cargo', ['build', '--quiet', '--manifest-path', join(crate, 'Cargo.toml')], repo);
    await run('rustc', ['--edition=2021', join(repo, 'apps/cli/tests/native-session-bash.rs'), '-o', binary,
        '--extern', `itookit_sanbox=${rlib}`, '-L', `dependency=${join(target, 'deps')}`], repo);
}
