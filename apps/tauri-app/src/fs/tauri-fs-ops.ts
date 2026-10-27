/**
 * @file apps/tauri-app/src/fs/tauri-fs-ops.ts
 *
 * TauriFsOps — IFsOps backed by custom Rust FS commands (fs_stat, fs_read_file, …).
 *
 * Why not @tauri-apps/plugin-fs?
 *   The plugin-fs scope uses Rust's glob crate with require_literal_leading_dot=true.
 *   This means `path/**` never matches `path/.hidden`, blocking access to VFS paths
 *   like .connections, .mcp, .skills, etc. regardless of allow_directory() calls.
 *   Our Rust commands skip the glob scope entirely and validate paths directly
 *   against the allowed dirs (nestos_dir and home_dir set in AppPaths state).
 */

import { invoke } from '@tauri-apps/api/core';
import type { IFsOps, StatResult, DirEntry } from '@itookit/vfsdriver-local';

interface RustStatResult {
    size:         number;
    mtime_ms:     number;
    birthtime_ms: number;
    is_directory: boolean;
    is_symbolic_link: boolean;
    is_file: boolean;
}

interface RustDirEntry {
    name:         string;
    is_directory: boolean;
}

export class TauriFsOps implements IFsOps {

    async stat(p: string): Promise<StatResult | null> {
        const r = await invoke<RustStatResult | null>('fs_stat', { path: p });
        if (!r) return null;
        return {
            size:        r.size,
            mtimeMs:     r.mtime_ms,
            birthtimeMs: r.birthtime_ms,
            isDirectory: r.is_directory,
            isSymbolicLink: r.is_symbolic_link,
            isFile: r.is_file,
        };
    }

    /** One IPC for many stats; the VFS capability check coalesces its path-prefix walk into this. */
    async statMany(paths: string[]): Promise<Array<StatResult | null>> {
        const rows = await invoke<Array<RustStatResult | null>>('fs_stat_many', { paths });
        return rows.map(r => r ? {
            size:        r.size,
            mtimeMs:     r.mtime_ms,
            birthtimeMs: r.birthtime_ms,
            isDirectory: r.is_directory,
            isSymbolicLink: r.is_symbolic_link,
            isFile: r.is_file,
        } : null);
    }

    async mkdir(p: string): Promise<void> {
        try {
            await invoke('fs_mkdir', { path: p });
        } catch (e) {
            console.error('[TauriFsOps] mkdir failed', { path: p, error: e });
            throw e;
        }
    }

    async readFile(p: string): Promise<ArrayBuffer | null> {
        try {
            return await invoke<ArrayBuffer>('fs_read_file', { path: p });
        } catch {
            return null;
        }
    }

    async writeFile(p: string, data: ArrayBuffer): Promise<void> {
        try {
            await invoke('fs_write_file', {
                path: p,
                data: Array.from(new Uint8Array(data)),
            });
        } catch (e) {
            console.error('[TauriFsOps] writeFile failed', { path: p, error: e });
            throw e;
        }
    }

    async appendFile(p: string, data: ArrayBuffer): Promise<void> {
        await invoke('fs_append_file', {
            path: p,
            data: Array.from(new Uint8Array(data)),
        });
    }

    async readDir(p: string): Promise<DirEntry[]> {
        try {
            const entries = await invoke<RustDirEntry[]>('fs_read_dir', { path: p });
            return entries.map(e => ({ name: e.name, isDirectory: e.is_directory }));
        } catch {
            return [];
        }
    }

    async rename(from: string, to: string): Promise<void> {
        await invoke('fs_rename', { from, to });
    }

    async unlink(p: string): Promise<void> {
        try {
            await invoke('fs_remove', { path: p, recursive: false });
        } catch { /* ignore ENOENT */ }
    }

    async rmdir(p: string): Promise<void> {
        try {
            await invoke('fs_remove', { path: p, recursive: false });
        } catch { /* ignore non-empty or missing */ }
    }

    async exists(p: string): Promise<boolean> {
        return invoke<boolean>('fs_exists', { path: p });
    }
}
