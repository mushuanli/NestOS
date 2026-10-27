import defaultSettings from './default-profile.json';

export const DEFAULT_NESTOS_SETTINGS: Readonly<NestOSProfileSettings> = Object.freeze(defaultSettings);

/** Canonical NestOS config file name under $XDG_CONFIG_HOME/nestos or ~/.config/nestos. */
export const NESTOS_CONFIG_FILE = 'nestos.json';

export interface NestOSProfileSettings {
    /** Absolute or config-dir-relative data root. */
    rootDir?: string;
    /** Optional host working directory override. */
    homeDir?: string;
    /** Persistence schema version expected by this profile. */
    storageVersion?: number;
    /** On-disk layout version. */
    layoutVersion?: number;
}

export interface NestOSProfile {
    configDir: string;
    dataRoot: string;
    homeDir?: string;
    storageVersion: number;
    layoutVersion: number;
}

export interface ResolveNestOSProfileOptions {
    configDir: string;
    settings?: NestOSProfileSettings | null;
    env?: { NESTOS_ROOT?: string | undefined; MINDOS_ROOT?: string | undefined } | undefined;
    /** Host-specific resolver for relative `rootDir` values. */
    resolvePath?: (base: string, relative: string) => string;
}

const DEFAULT_STORAGE_VERSION = 1;
const DEFAULT_LAYOUT_VERSION = 1;

function defaultResolvePath(base: string, relative: string): string {
    if (relative.startsWith('/')) return relative;
    return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

/**
 * Resolve the host-neutral NestOS profile identity from parsed config.
 *
 * Hosts own file I/O and pass their path semantics via `resolvePath`.
 */
export function resolveNestOSProfile(options: ResolveNestOSProfileOptions): NestOSProfile {
    const configDir = options.configDir;
    const envRoot = (options.env?.NESTOS_ROOT ?? options.env?.MINDOS_ROOT)?.trim();
    const settingsRoot = options.settings?.rootDir?.trim();
    const resolvePath = options.resolvePath ?? defaultResolvePath;

    const dataRoot = envRoot
        ? envRoot
        : settingsRoot
            ? resolvePath(configDir, settingsRoot)
            : defaultResolvePath(configDir, 'data');

    return {
        configDir,
        dataRoot,
        ...(options.settings?.homeDir ? { homeDir: options.settings.homeDir } : {}),
        storageVersion: options.settings?.storageVersion ?? DEFAULT_STORAGE_VERSION,
        layoutVersion: options.settings?.layoutVersion ?? DEFAULT_LAYOUT_VERSION,
    };
}

/** @deprecated Use the NestOS names. Existing integrations retain their profile identity. */
export {resolveNestOSProfile as resolveMindOSProfile, DEFAULT_NESTOS_SETTINGS as DEFAULT_MINDOS_SETTINGS};
export const MINDOS_CONFIG_FILE = 'mindos.json';
export type {NestOSProfile as MindOSProfile, NestOSProfileSettings as MindOSProfileSettings, ResolveNestOSProfileOptions as ResolveMindOSProfileOptions};
