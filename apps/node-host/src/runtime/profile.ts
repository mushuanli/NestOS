import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {adoptLegacyEnvironment} from './legacy-environment';
import { DEFAULT_NESTOS_SETTINGS, NESTOS_CONFIG_FILE, resolveNestOSProfile, type NestOSProfileSettings } from '@itookit/app-core/profile';

adoptLegacyEnvironment();
export function configDirectory(): string {
    const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), current = path.join(base, 'nestos'), legacy = path.join(base, 'mindos');
    return !existsSync(path.join(current, NESTOS_CONFIG_FILE)) && existsSync(path.join(legacy, 'mindos.json')) ? legacy : current;
}
export function configurationFilePath(directory: string): string {
    const current = path.join(directory, NESTOS_CONFIG_FILE), legacy = path.join(directory, 'mindos.json');
    return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

interface NodeProfileSettings extends NestOSProfileSettings {
    http?: {certDir?: string; authDir?: string; editorSwap?: boolean; swapDir?: string};
}

/** Configured paths are relative to the config directory; explicit flags are relative to cwd. */
export async function resolveHttpDirectories(configDir: string, cwd: string,
    overrides: {certDir?: string; authDir?: string} = {}, mode = 'standalone'): Promise<{certDir: string; authDir: string; editorSwap: {enabled: boolean; directory: string}}> {
    const settings = await readSettings(configDir), http = settings.http;
    if (http !== undefined && (!http || typeof http !== 'object' || Array.isArray(http)))
        throw new Error('Expected http to be an object in nestos.json');
    for (const key of ['certDir', 'authDir'] as const) {
        if (http?.[key] !== undefined && (typeof http[key] !== 'string' || !http[key]!.trim()))
            throw new Error(`Expected http.${key} to be a non-empty path in nestos.json`);
    }
    const authBase = path.resolve(configDir, http?.authDir ?? 'http-auth');
    if (http?.editorSwap !== undefined && typeof http.editorSwap !== 'boolean') throw new Error('Expected http.editorSwap to be a boolean');
    if (http?.swapDir !== undefined && (typeof http.swapDir !== 'string' || !http.swapDir.trim())) throw new Error('Expected http.swapDir to be a non-empty path');
    const swapDir = http?.swapDir ?? path.join(homedir(), 'swap');
    return {
        editorSwap: {enabled: http?.editorSwap === true, directory: swapDir === '~' ? homedir()
            : swapDir.startsWith('~/') ? path.join(homedir(), swapDir.slice(2)) : path.resolve(configDir, swapDir)},
        certDir: overrides.certDir !== undefined ? path.resolve(cwd, overrides.certDir) : path.resolve(configDir, http?.certDir ?? 'http-certs'),
        authDir: overrides.authDir !== undefined ? path.resolve(cwd, overrides.authDir)
            : mode === 'release' || mode === 'dev' ? path.join(authBase, mode) : authBase,
    };
}

/** Resolve the shared profile, retaining explicit command-line root overrides. */
export async function resolveDataRoot(configDir: string, cwd: string, root?: string, envRoot = process.env.NESTOS_ROOT): Promise<string> {
    if (root !== undefined) return path.resolve(cwd, root);
    const settings = await readSettings(configDir);
    const profile = resolveNestOSProfile({ configDir, settings, env: { NESTOS_ROOT: envRoot },
        resolvePath: (base, relative) => path.resolve(base, relative) });
    return path.resolve(cwd, profile.dataRoot);
}

async function readSettings(configDir: string): Promise<NodeProfileSettings> {
    const file = configurationFilePath(configDir);
    await mkdir(configDir, { recursive: true });
    try { await writeFile(file, JSON.stringify(DEFAULT_NESTOS_SETTINGS, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Expected a NestOS profile object in ${file}`);
    const settings = raw as NodeProfileSettings;
    if (settings.rootDir !== undefined && typeof settings.rootDir !== 'string') throw new Error(`Expected rootDir to be a string in ${file}`);
    return settings;
}
