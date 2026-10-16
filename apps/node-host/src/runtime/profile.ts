import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MINDOS_SETTINGS, MINDOS_CONFIG_FILE, resolveMindOSProfile, type MindOSProfileSettings } from '@itookit/app-core/profile';

export function configDirectory(): string {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'mindos');
}

/** Resolve the shared profile, retaining explicit command-line root overrides. */
export async function resolveDataRoot(configDir: string, cwd: string, root?: string, envRoot = process.env.MINDOS_ROOT): Promise<string> {
    if (root !== undefined) return path.resolve(cwd, root);
    const settings = await readSettings(configDir);
    const profile = resolveMindOSProfile({ configDir, settings, env: { MINDOS_ROOT: envRoot },
        resolvePath: (base, relative) => path.resolve(base, relative) });
    return path.resolve(cwd, profile.dataRoot);
}

async function readSettings(configDir: string): Promise<MindOSProfileSettings> {
    const file = path.join(configDir, MINDOS_CONFIG_FILE);
    await mkdir(configDir, { recursive: true });
    try { await writeFile(file, JSON.stringify(DEFAULT_MINDOS_SETTINGS, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Expected a MindOS profile object in ${file}`);
    const settings = raw as MindOSProfileSettings;
    if (settings.rootDir !== undefined && typeof settings.rootDir !== 'string') throw new Error(`Expected rootDir to be a string in ${file}`);
    return settings;
}
