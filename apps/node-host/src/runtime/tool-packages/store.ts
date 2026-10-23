import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from '@itookit/common';
import {packageError, packageIdentity} from './manifest';
import type {ExecutableBinding} from './files';

export interface RegisteredToolPackage {id: string; version: string; fingerprint: string; bindings: ExecutableBinding[];}
const updates = new Map<string, Promise<void>>();

/** Serialize in-process hosts sharing one metadata file without dropping sibling records. */
export function withToolPackageRegistry<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const work = (updates.get(file) ?? Promise.resolve()).then(async () => {
        const release = await acquireRegistryLock(file);
        try {return await operation();} finally {await release();}
    }), drained = work.then(() => {}, () => {});
    updates.set(file, drained); void drained.finally(() => {if (updates.get(file) === drained) updates.delete(file);});
    return work;
}

async function acquireRegistryLock(file: string): Promise<() => Promise<void>> {
    await mkdir(path.dirname(file), {recursive: true});
    const moduleName = 'node:sqlite';
    const {DatabaseSync} = await import(moduleName) as {DatabaseSync: new (file: string) => {exec(sql: string): void; close(): void}};
    const database = new DatabaseSync(`${file}.lock.sqlite`), deadline = Date.now() + 10_000;
    while (true) {
        try {
            database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
            return async () => {database.close();};
        } catch (error) {
            if (!(error instanceof Error) || !/database is (?:locked|busy)/i.test(error.message)) {database.close(); throw error;}
            if (Date.now() >= deadline) {database.close(); throw packageError('TOOL_PACKAGE_REGISTRY_BUSY', 'Another host is registering tool packages; retry after it finishes');}
            await new Promise(resolve => setTimeout(resolve, 40));
        }
    }
}

export async function readToolPackageRegistry(file: string): Promise<RegisteredToolPackage[]> {
    let raw: string;
    try {raw = await readFile(file, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    let value: {format?: unknown; packages?: unknown};
    try {value = JSON.parse(raw);} catch {throw packageError('TOOL_PACKAGE_REGISTRY_INVALID', 'Tool package registration metadata contains invalid JSON');}
    if (value?.format !== 1 || !Array.isArray(value.packages)) throw packageError('TOOL_PACKAGE_REGISTRY_INVALID', 'Invalid tool package registration metadata');
    const records = value.packages.map(item => {
        const id = packageIdentity(item?.id, 'registered id'), version = packageIdentity(item?.version, 'registered version');
        if (typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) || !Array.isArray(item.bindings)
            || item.bindings.some((binding: ExecutableBinding) => !binding || typeof binding.env !== 'string' || typeof binding.path !== 'string'
                || !path.isAbsolute(binding.path) || !['environment', 'path', 'package'].includes(binding.source)))
            throw packageError('TOOL_PACKAGE_REGISTRY_INVALID', 'Invalid registered tool package metadata');
        return {id, version, fingerprint: item.fingerprint as string, bindings: item.bindings as ExecutableBinding[]};
    });
    if (new Set(records.map(record => record.id)).size !== records.length) throw packageError('TOOL_PACKAGE_REGISTRY_INVALID', 'Duplicate registered tool package');
    return records;
}

/** Metadata is replaced atomically; package content never enters the configuration directory. */
export async function writeToolPackageRegistry(file: string, packages: RegisteredToolPackage[]): Promise<void> {
    await mkdir(path.dirname(file), {recursive: true}); const temporary = `${file}.${randomUUID()}.tmp`;
    try {await writeFile(temporary, JSON.stringify({format: 1, packages}, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); await rename(temporary, file);}
    finally {await rm(temporary, {force: true});}
}
