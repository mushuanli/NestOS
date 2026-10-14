import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_TOOLS } from '../index';
import { ToolDeviceDriver } from './tool-device-driver';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(['Grep', 'Glob'])('uses the shared ignore policy for standalone native %s', async toolId => {
    const root = await mkdtemp(join(tmpdir(), 'search-ignore-')); roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, '.gitignore'), '*.log\n');
    await writeFile(join(root, '.mindosignore'), 'private.txt\n');
    for (const name of ['keep.txt', 'private.txt', 'output.log']) await writeFile(join(root, 'src', name), 'mdx');
    const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
    // Accelerators must not bypass the shared discovery policy.
    const exec = vi.fn(); driver.setNativeShell({ capabilities: { fd: true, ripgrep: true }, exec });
    const args = { pattern: toolId === 'Grep' ? 'mdx' : '**/*', path: join(root, 'src') };
    const result = await driver.invoke({ toolId, cwd: root, args });
    expect(result.success).toBe(true);
    expect(result.output).toContain('keep.txt');
    expect(result.output).not.toMatch(/private.txt|output.log/);
    const all = await driver.invoke({ toolId, cwd: root, args: { ...args, includeIgnored: true } });
    expect(all.success).toBe(true);
    expect(all.output).toContain('private.txt');
    expect(all.output).toContain('output.log');
    expect(exec).not.toHaveBeenCalled();
});
