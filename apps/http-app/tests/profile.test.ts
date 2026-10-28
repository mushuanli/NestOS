import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configDirectory, resolveDataRoot, resolveHttpConfigDirectory, resolveHttpDirectories } from '@itookit/node-host/runtime';
import { options } from '@itookit/node-host/http';

let temp: string, config: string, cwd: string;
beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), 'nestos-http-profile-'));
    config = path.join(temp, 'config', 'nestos'); cwd = path.join(temp, 'workspace');
    await mkdir(config, { recursive: true });
    vi.stubEnv('NESTOS_ROOT', '');
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
    await writeFile(path.join(config, 'nestos.json'), contents);
    expect(await resolveDataRoot(config, cwd)).toBe(path.join(temp, 'personal-data'));
    expect(await readFile(path.join(config, 'nestos.json'), 'utf8')).toBe(contents);
});

it('creates the shared default profile if missing', async () => {
    expect(await resolveDataRoot(config, cwd)).toBe(path.join(config, 'data'));
    expect(JSON.parse(await readFile(path.join(config, 'nestos.json'), 'utf8'))).toEqual({ rootDir: 'data', storageVersion: 1, layoutVersion: 1 });
});

it('prioritizes CLI overrides over environment overrides and configured roots', async () => {
    await writeFile(path.join(config, 'nestos.json'), JSON.stringify({ rootDir: path.join(temp, 'configured') }));
    vi.stubEnv('NESTOS_ROOT', path.join(temp, 'environment'));
    expect(await resolveDataRoot(config, cwd)).toBe(path.join(temp, 'environment'));
    expect(await resolveDataRoot(config, cwd, 'explicit')).toBe(path.join(cwd, 'explicit'));
});

it('rejects malformed profiles instead of silently using a different data root', async () => {
    await writeFile(path.join(config, 'nestos.json'), '{');
    await expect(resolveDataRoot(config, cwd)).rejects.toThrow();
    await writeFile(path.join(config, 'nestos.json'), '{"rootDir":42}');
    await expect(resolveDataRoot(config, cwd)).rejects.toThrow('Expected rootDir');
});

it('prefers the launch directory profile over XDG and resolves paths relative to it', async () => {
    await mkdir(cwd, {recursive: true});
    vi.stubEnv('XDG_CONFIG_HOME', path.join(temp, 'config'));
    await writeFile(path.join(cwd, 'nestos.json'), JSON.stringify({rootDir: './portable-data'}));
    const selected = resolveHttpConfigDirectory(cwd);
    expect(selected).toEqual({directory: cwd, source: 'working-directory'});
    expect(await resolveDataRoot(selected.directory, cwd)).toBe(path.join(cwd, 'portable-data'));
});
it('falls back to XDG only when the launch directory has no profile and rejects malformed local files', async () => {
    await mkdir(cwd, {recursive: true});
    vi.stubEnv('XDG_CONFIG_HOME', path.join(temp, 'config'));
    expect(resolveHttpConfigDirectory(cwd)).toEqual({directory: config, source: 'user-config'});
    await writeFile(path.join(cwd, 'nestos.json'), '{');
    expect(resolveHttpConfigDirectory(cwd)).toEqual({directory: cwd, source: 'working-directory'});
    await expect(resolveDataRoot(cwd, cwd)).rejects.toThrow();
});

it('reads user storage and certificate mappings from JSON and keeps CLI directory precedence', async () => {
    const policy = {['a'.repeat(64)]: {userId: 'admin'}};
    await writeFile(path.join(config, 'nestos.json'), JSON.stringify({http: {usersDir: './data/home', mtls: {clients: policy}}}));
    const settings = await resolveHttpDirectories(config, cwd);
    expect(settings.usersDir).toBe(path.join(config, 'data/home'));
    expect(await settings.certificateClients!()).toEqual(policy);
    expect((await resolveHttpDirectories(config, cwd, {usersDir: './override'})).usersDir).toBe(path.join(cwd, 'override'));
    await writeFile(path.join(config, 'nestos.json'), JSON.stringify({http: {mtls: {clients: {}}}}));
    await expect(settings.certificateClients!()).rejects.toMatchObject({code: 'CLIENT_POLICY_INVALID'});
});
