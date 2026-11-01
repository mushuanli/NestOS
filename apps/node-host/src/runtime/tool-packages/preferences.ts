import {mkdir, lstat, readFile, open, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ToolPackageSettings} from '@itookit/app-contracts/services';
import {packageError} from './manifest';
const log = createModuleLogger('tool-preferences');
const code = (value: string) => packageError(`TOOL_PACKAGE_PREFERENCES_${value}`, `Tool preferences ${value.toLowerCase().replaceAll('_', ' ')}`);

/** The authenticated runtime chooses the path; requests never carry a user ID or filename. */
export class ToolPreferences {
    private values: Record<string, ToolPackageSettings> = {};
    private migrations: Record<string, string> = {};
    private tail = Promise.resolve();
    constructor(private readonly file: string) {}
    has(key: string): boolean {return Object.hasOwn(this.values, key);}
    migratedFrom(key: string, version: string): boolean {return this.migrations[key] === version;}
    async initialize(): Promise<void> {
        try {
            await this.check(path.dirname(this.file), true); await this.check(this.file);
            const info = await lstat(this.file); if (info.size > 1024 * 1024) throw code('TOO_LARGE');
            const data = JSON.parse(await readFile(this.file, 'utf8'));
            if (data?.version !== 1 || !data.packages || typeof data.packages !== 'object' || Array.isArray(data.packages)) throw code('INVALID');
            for (const value of Object.values(data.packages)) validateSettings(value);
            this.values = data.packages;
            if (data.migrations !== undefined && (!data.migrations || typeof data.migrations !== 'object' || Array.isArray(data.migrations)
                || Object.values(data.migrations).some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value)))) throw code('INVALID');
            this.migrations = data.migrations ?? {};
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            if (error instanceof SyntaxError) throw code('INVALID');
            throw error;
        }
    }
    enabled(key: string, toolId?: string, defaultEnabled = false): boolean {return (this.values[key]?.enabled ?? defaultEnabled) === true && (!toolId || !this.values[key]?.disabledTools?.includes(toolId));}
    defaults(key: string, toolId: string): Record<string, unknown> {return structuredClone(this.values[key]?.defaults[toolId] ?? {});}
    get(key: string): ToolPackageSettings {return structuredClone(Object.hasOwn(this.values, key) ? this.values[key] : {enabled: false, defaults: {}});}
    save(key: string, settings: ToolPackageSettings): Promise<void> {
        return this.saveValue(key, settings);
    }
    saveMigrated(key: string, version: string, settings: ToolPackageSettings): Promise<void> {
        return this.saveValue(key, settings, version);
    }
    private saveValue(key: string, settings: ToolPackageSettings, migratedFrom?: string): Promise<void> {
        validateSettings(settings); const copy = structuredClone(settings), operationId = randomUUID(), started = Date.now();
        const work = this.tail.then(async () => {
            try {
                const migrations = {...this.migrations};
                if (migratedFrom) migrations[key] = migratedFrom; else delete migrations[key];
                await this.persist({...this.values, [key]: copy}, migrations); this.values[key] = copy; this.migrations = migrations;
                log.info('tool.preferences.save', {operationId, stage: 'persist', result: 'success', durationMs: Date.now() - started});
            } catch (error) {
                const failure = (error as {code?: string}).code?.startsWith('TOOL_PACKAGE_PREFERENCES_') ? error : code('WRITE_FAILED');
                log.warn('tool.preferences.save', {operationId, stage: 'persist', result: 'failure', code: (failure as {code: string}).code, durationMs: Date.now() - started}); throw failure;
            }
        }); this.tail = work.catch(() => {}); return work;
    }
    remove(key: string): Promise<void> {
        const work = this.tail.then(async () => {
            const next = {...this.values}, migrations = {...this.migrations}; delete next[key]; delete migrations[key];
            await this.persist(next, migrations); this.values = next; this.migrations = migrations;
        }); this.tail = work.catch(() => {}); return work;
    }
    private async persist(packages: Record<string, ToolPackageSettings>, migrations = this.migrations): Promise<void> {
        const directory = path.dirname(this.file), temporary = path.join(directory, `${randomUUID()}.tmp`);
        await mkdir(directory, {recursive: true, mode: 0o700}); await this.check(directory, true);
        try {await this.check(this.file);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
        const data = JSON.stringify({version: 1, packages, ...(Object.keys(migrations).length ? {migrations} : {})}); if (Buffer.byteLength(data) > 1024 * 1024) throw code('TOO_LARGE');
        try {
            const file = await open(temporary, 'wx', 0o600);
            try {await file.writeFile(data); await file.sync();} finally {await file.close();}
            await rename(temporary, this.file);
        } finally {await rm(temporary, {force: true});}
    }
    private async check(file: string, directory = false): Promise<void> {
        const info = await lstat(file);
        if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
            || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw code('NOT_PRIVATE');
    }
}
export function validateSettings(value: unknown): asserts value is ToolPackageSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw code('INVALID');
    const item = value as ToolPackageSettings;
    if (typeof item.enabled !== 'boolean' || !item.defaults || typeof item.defaults !== 'object' || Array.isArray(item.defaults)
        || Object.keys(item).some(key => !['enabled', 'defaults', 'disabledTools'].includes(key))) throw code('INVALID');
    if (item.disabledTools !== undefined && (!Array.isArray(item.disabledTools) || item.disabledTools.length > 100 || item.disabledTools.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(id)))) throw code('INVALID');
    let text: string;
    try {text = JSON.stringify(item, (key, entry) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key) || entry === undefined || typeof entry === 'function'
            || typeof entry === 'bigint' || typeof entry === 'symbol' || typeof entry === 'number' && !Number.isFinite(entry)) throw code('INVALID');
        return entry;
    });} catch {throw code('INVALID');}
    if (Buffer.byteLength(text) > 65536 || Object.values(item.defaults).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw code('INVALID');
}
