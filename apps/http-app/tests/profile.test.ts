import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configDirectory, resolveDataRoot } from '../src/server/profile';
import { options } from '../src/server/options';

let temp: string, config: string, cwd: string;
beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'mindos-http-profile-'));
    config = path.join(temp, 'config', 'mindos'); cwd = path.join(temp, 'workspace');
    await mkdir(config, { recursive: true });
    vi.stubEnv('MINDOS_ROOT', '');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temp, { recursive: true, force: true }); });

it('uses every IPv4 interface on port 2000 by default and accepts overrides', () => {
    expect(options([])).toMatchObject({ host: '0.0.0.0', port: '2000' });
    expect(options(['--host', '127.0.0.1', '--port', '3000'])).toMatchObject({ host: '127.0.0.1', port: '3000' });
});

it('uses the XDG configuration directory for profile, certificates and logs', () => {
    vi.stubEnv('XDG_CONFIG_HOME', path.join(temp, 'config'));
    expect(configDirectory()).toBe(config);
});

it('reads an existing profile relative to its config directory and preserves it', async () => {
    const contents = '{"rootDir":"../../personal-data","storageVersion":1}\n';
    await writeFile(path.join(config, 'mindos.json'), contents);
    expect(await resolveDataRoot(config, cwd)).toBe(path.join(temp, 'personal-data'));
    expect(await readFile(path.join(config, 'mindos.json'), 'utf8')).toBe(contents);
});

it('creates the shared default profile if missing', async () => {
    expect(await resolveDataRoot(config, cwd)).toBe(path.join(config, 'data'));
    expect(JSON.parse(await readFile(path.join(config, 'mindos.json'), 'utf8'))).toEqual({ rootDir: 'data', storageVersion: 1, layoutVersion: 1 });
});

it('prioritizes CLI overrides over environment overrides and configured roots', async () => {
    await writeFile(path.join(config, 'mindos.json'), JSON.stringify({ rootDir: path.join(temp, 'configured') }));
    vi.stubEnv('MINDOS_ROOT', path.join(temp, 'environment'));
    expect(await resolveDataRoot(config, cwd)).toBe(path.join(temp, 'environment'));
    expect(await resolveDataRoot(config, cwd, 'explicit')).toBe(path.join(cwd, 'explicit'));
});

it('rejects malformed profiles instead of silently using a different data root', async () => {
    await writeFile(path.join(config, 'mindos.json'), '{');
    await expect(resolveDataRoot(config, cwd)).rejects.toThrow();
    await writeFile(path.join(config, 'mindos.json'), '{"rootDir":42}');
    await expect(resolveDataRoot(config, cwd)).rejects.toThrow('Expected rootDir');
});
