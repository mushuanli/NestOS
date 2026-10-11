// @file: device-llm/device/vfs-helpers.ts
//
// VFSHelpers — low-level VFS read/write utilities shared across manager classes.

import type { IFileSystem, CreateFileOptions } from '@itookit/vfs-core';
import yaml from 'js-yaml';

type ConfigValidator<T> = (value: unknown, path: string) => value is T;

export class VFSHelpers {
    constructor(private readonly engine: IFileSystem) {}

    /** Expose the underlying engine for callers that need raw driver access */
    getFileSystem(): IFileSystem {
        return this.engine;
    }

    async readJson<T>(path: string, systemFS?: IFileSystem): Promise<T | null> {
        try {
            const fs = systemFS ?? this.engine;
            const nodeId = await fs.driver.resolvePath(path);
            if (!nodeId) return null;
            const raw = await fs.driver.readContent(nodeId, { representation: 'bytes' });
            const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
            return JSON.parse(text) as T;
        } catch { return null; }
    }

    writeJson(path: string, data: unknown, systemFS?: IFileSystem): Promise<void> {
        return this.engineUpsert(path, JSON.stringify(data, null, 2), systemFS);
    }

    async engineUpsert(path: string, content: string, systemFS?: IFileSystem): Promise<void> {
        const fs = systemFS ?? this.engine;
        const nodeId = await fs.driver.resolvePath(path);
        if (nodeId) {
            await fs.driver.writeContent(nodeId, content);
        } else {
            const name = path.substring(path.lastIndexOf('/') + 1);
            const parent = path.substring(0, path.lastIndexOf('/')) || '/';
            await fs.driver.createFile({
                name,
                parentPath: parent,
                content,
                recursive: true,
            } as CreateFileOptions);
        }
    }

    /** Load supported YAML/JSON configuration files from a VFS directory. */
    async loadJsonFilesFromDir<T>(dirPath: string, systemFS?: IFileSystem, validate?: ConfigValidator<T>): Promise<T[]> {
        return this.loadFilesFromDir(dirPath, ['.yaml', '.yml', '.json'], systemFS, validate);
    }

    /** Canonical YAML collections do not probe older configuration formats. */
    async loadYamlFilesFromDir<T>(dirPath: string, systemFS?: IFileSystem, validate?: ConfigValidator<T>): Promise<T[]> {
        return this.loadFilesFromDir(dirPath, ['.yaml'], systemFS, validate);
    }

    private async loadFilesFromDir<T>(dirPath: string, extensions: string[], systemFS?: IFileSystem, validate?: ConfigValidator<T>): Promise<T[]> {
        const items: T[] = [];
        const t0 = performance.now();
        try {
            const fs = systemFS ?? this.engine;
            const dirId = await fs.driver.resolvePath(dirPath);
            if (!dirId) { console.log(`[Boot]       loadDir ${dirPath}: empty`); return []; }
            const children = await fs.driver.getChildren(dirId, { fields: 'entry' });
            console.log(`[Boot]       loadDir ${dirPath}: ${children.length} entries`);
            const files = children.filter(child => child.type === 'file'
                && extensions.some(extension => child.name.endsWith(extension)));
            // Bound remote reads and preserve directory order regardless of completion order.
            for (let offset = 0; offset < files.length; offset += 8) {
                const loaded = await Promise.all(files.slice(offset, offset + 8)
                    .map(child => this.readConfigFile<T>(fs, child.path, child.name, validate)));
                for (const item of loaded) if (item !== null) items.push(item);
            }
            console.log(`[Boot]       loadDir ${dirPath}: ${items.length} loaded in ${(performance.now() - t0).toFixed(0)}ms`);
        } catch { /* directory not yet created */ }
        return items;
    }

    private async readConfigFile<T>(fs: IFileSystem, path: string, name: string, validate?: ConfigValidator<T>): Promise<T | null> {
        try {
            const raw = await fs.driver.readContent(path, { representation: 'bytes' });
            const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
            const parsed = name.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
            if (parsed === null || parsed === undefined) {
                console.warn(`[VFSHelpers] loadDir skip empty ${path}`);
                return null;
            }
            if (validate && !validate(parsed, path)) {
                console.warn(`[VFSHelpers] loadDir skip invalid ${path}`);
                return null;
            }
            return parsed as T;
        } catch (error) {
            console.warn(`[VFSHelpers] loadDir skip ${path}:`, error instanceof Error ? error.message : error);
            return null;
        }
    }

}
