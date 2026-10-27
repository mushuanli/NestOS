import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MINDOS_SETTINGS, MINDOS_CONFIG_FILE, resolveMindOSProfile, type MindOSProfileSettings } from '@itookit/app-core/profile';

export function configDirectory(): string {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'mindos');
}

interface NodeProfileSettings extends MindOSProfileSettings {
    http?: {certDir?: string; authDir?: string};
}

/** Configured paths are relative to the config directory; explicit flags are relative to cwd. */
export async function resolveHttpDirectories(configDir: string, cwd: string,
    overrides: {certDir?: string; authDir?: string} = {}, mode = 'standalone'): Promise<{certDir: string; authDir: string}> {
    const settings = await readSettings(configDir), http = settings.http;
    if (http !== undefined && (!http || typeof http !== 'object' || Array.isArray(http)))
        throw new Error('Expected http to be an object in mindos.json');
    for (const key of ['certDir', 'authDir'] as const) {
        if (http?.[key] !== undefined && (typeof http[key] !== 'string' || !http[key]!.trim()))
            throw new Error(`Expected http.${key} to be a non-empty path in mindos.json`);
    }
    const authBase = path.resolve(configDir, http?.authDir ?? 'http-auth');
    return {
        certDir: overrides.certDir !== undefined ? path.resolve(cwd, overrides.certDir) : path.resolve(configDir, http?.certDir ?? 'http-certs'),
        authDir: overrides.authDir !== undefined ? path.resolve(cwd, overrides.authDir)
            : mode === 'release' || mode === 'dev' ? path.join(authBase, mode) : authBase,
    };
}

/** Resolve the shared profile, retaining explicit command-line root overrides. */
export async function resolveDataRoot(configDir: string, cwd: string, root?: string, envRoot = process.env.MINDOS_ROOT): Promise<string> {
    if (root !== undefined) return path.resolve(cwd, root);
    const settings = await readSettings(configDir);
    const profile = resolveMindOSProfile({ configDir, settings, env: { MINDOS_ROOT: envRoot },
        resolvePath: (base, relative) => path.resolve(base, relative) });
    return path.resolve(cwd, profile.dataRoot);
}

async function readSettings(configDir: string): Promise<NodeProfileSettings> {
    const file = path.join(configDir, MINDOS_CONFIG_FILE);
    await mkdir(configDir, { recursive: true });
    try { await writeFile(file, JSON.stringify(DEFAULT_MINDOS_SETTINGS, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Expected a MindOS profile object in ${file}`);
    const settings = raw as NodeProfileSettings;
    if (settings.rootDir !== undefined && typeof settings.rootDir !== 'string') throw new Error(`Expected rootDir to be a string in ${file}`);
    return settings;
}
