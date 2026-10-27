/**
 * @file apps/cli/src/nestos.ts
 *
 * NestOS profile resolution for the headless CLI.
 * Reads the shared config file ($XDG_CONFIG_HOME/nestos/nestos.json or
 * ~/.config/nestos/nestos.json) and resolves the real NestOS data root.
 * Mirrors apps/tauri-app/src-tauri/src/lib.rs `resolve_all_paths`.
 */
import {configurationFilePath, configDirectory} from '@itookit/node-host/runtime';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    DEFAULT_NESTOS_SETTINGS,
    resolveNestOSProfile as resolveProfile,
    type NestOSProfile,
    type NestOSProfileSettings,
} from '@itookit/app-core';

/** Config dir: $XDG_CONFIG_HOME/nestos or ~/.config/nestos. */
function configDir(): string { return configDirectory(); }

function ensureSettings(): void {
    mkdirSync(configDir(), { recursive: true });
    try {
        writeFileSync(configurationFilePath(configDir()), JSON.stringify(DEFAULT_NESTOS_SETTINGS, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
}

function readSettings(): NestOSProfileSettings {
    ensureSettings();
    try {
        const raw = JSON.parse(readFileSync(configurationFilePath(configDir()), 'utf8'));
        return {
            rootDir: typeof raw.rootDir === 'string' && raw.rootDir ? raw.rootDir : undefined,
            homeDir: typeof raw.homeDir === 'string' && raw.homeDir ? raw.homeDir : undefined,
            storageVersion: typeof raw.storageVersion === 'number' ? raw.storageVersion : undefined,
            layoutVersion: typeof raw.layoutVersion === 'number' ? raw.layoutVersion : undefined,
        };
    } catch {
        return {};
    }
}

/** Resolve the shared NestOS profile used by CLI and the desktop app. */
export function resolveNestosProfile(): NestOSProfile {
    return resolveProfile({
        configDir: configDir(),
        settings: readSettings(),
        env: { NESTOS_ROOT: process.env.NESTOS_ROOT },
        resolvePath: (base, relative) => path.resolve(base, relative),
    });
}

/** Resolve the nestos data root. Kept as the CLI's narrow convenience helper. */
export function resolveNestosRoot(): string {
    return resolveNestosProfile().dataRoot;
}

export type CliProfileKind = 'desktop' | 'path';

export interface CliProfile {
    kind: CliProfileKind;
    root: string;
}

/**
 * Resolve the CLI profile selected by `--profile`.
 * - desktop: shared ~/.config/nestos profile (default)
 * - anything else: explicit data root path
 */
export function resolveCliProfile(profile?: string): CliProfile {
    const value = profile?.trim() || 'desktop';
    if (value === 'desktop') return { kind: 'desktop', root: resolveNestosProfile().dataRoot };
    return { kind: 'path', root: path.resolve(value) };
}

/** Resolve the physical profile root. */
export function resolveProfileRoot(profile?: string): string {
    return resolveCliProfile(profile).root;
}
