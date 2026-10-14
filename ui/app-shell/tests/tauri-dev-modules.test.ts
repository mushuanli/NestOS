import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('links the Tauri development module graph without missing default or named exports', () => {
    const script = fileURLToPath(new URL('../../../scripts/check-tauri-dev-modules.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', script], {
        encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toMatch(/Linked Tauri development graph: \d+ modules/);
});
