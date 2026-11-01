import {createHash} from 'node:crypto';
import {mkdir, open, readFile, lstat, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import type {Tool, ToolUseContext} from '@itookit/tools';
import {sha256HexSync, randomUUID} from '@itookit/common';
import {packageError, packageIdentity} from './manifest';
import type {RegisteredToolPackage} from './store';

export interface ImplementationRef {format: 1; packageId: string; version: string; fingerprint: string; toolId: string; toolVersion: string}
export function implementationRef(record: RegisteredToolPackage, tool: Tool): ImplementationRef {
    return {format: 1, packageId: record.id, version: record.version, fingerprint: record.fingerprint, toolId: tool.name, toolVersion: tool.version ?? '1'};
}
function referenceKey(tool: Tool, context: ToolUseContext): string {
    return 'tool-package-implementation/' + createHash('sha256').update(JSON.stringify([tool.name, tool.version ?? '1', context.executionIdentity!.effectId])).digest('hex');
}
export async function pinImplementation(tool: Tool, context: ToolUseContext, phase: 'invoke' | 'reconcile', current: () => RegisteredToolPackage): Promise<ImplementationRef> {
    context.signal?.throwIfAborted();
    if (!context.executionIdentity) return implementationRef(current(), tool);
    if (!context.getAssetRecord || !context.putAssetRecord) throw packageError('TOOL_PACKAGE_BINDING_STORE_REQUIRED', 'Durable package execution requires a Task implementation record');
    const read = (key: string) => context.getAssetRecord!(key).catch(() => {throw packageError('TOOL_PACKAGE_BINDING_READ_FAILED', 'Unable to read the Task implementation binding');});
    const key = referenceKey(tool, context), stored = await read(key);
    if (stored !== undefined) return validateReference(stored, tool, current().id);
    const legacyKey = 'tool-input-defaults/' + sha256HexSync(JSON.stringify([tool.name, tool.version ?? '1', context.executionIdentity.effectId]));
    if (phase === 'reconcile' || await read(legacyKey) !== undefined)
        throw packageError('TOOL_PACKAGE_LEGACY_EXECUTION_UNBOUND', 'The previous execution has no implementation binding; reconcile with its original host version');
    const selected = implementationRef(current(), tool);
    context.signal?.throwIfAborted();
    try {await context.putAssetRecord(key, selected);}
    catch {throw packageError('TOOL_PACKAGE_BINDING_WRITE_FAILED', 'Unable to persist the implementation binding before execution');}
    return selected;
}
function validateReference(value: unknown, tool: Tool, packageId: string): ImplementationRef {
    const item = value as ImplementationRef;
    if (!item || item.format !== 1 || item.packageId !== packageId || item.toolId !== tool.name || item.toolVersion !== (tool.version ?? '1')
        || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint))
        throw packageError('TOOL_PACKAGE_BINDING_INVALID', 'Stored tool implementation identity is invalid');
    packageIdentity(item.version, 'implementation version'); return item;
}

/** Immutable execution receipts retain the exact manifest and binary bindings across restarts. */
export class ImplementationRecords {
    constructor(private readonly directory: string) {}
    private file(record: Pick<RegisteredToolPackage, 'id' | 'version' | 'fingerprint'>): string {
        packageIdentity(record.id, 'id'); packageIdentity(record.version, 'version');
        if (!/^[a-f0-9]{64}$/.test(record.fingerprint)) throw packageError('TOOL_PACKAGE_BINDING_INVALID', 'Invalid implementation fingerprint');
        return path.join(this.directory, '.implementations', record.id, record.version + '-' + record.fingerprint + '.json');
    }
    async save(record: RegisteredToolPackage): Promise<void> {
        const {previousVersion: _previous, activationId: _activation, ...immutable} = record;
        const file = this.file(record), data = JSON.stringify(immutable);
        await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
        try {
            if (JSON.stringify(await this.read(record)) !== data) throw packageError('TOOL_PACKAGE_BINDING_INVALID', 'Implementation receipt conflicts with existing identity');
            await syncParent(file); return;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {await handle.writeFile(data); await handle.sync();} finally {await handle.close();}
            await rename(temporary, file); await syncParent(file);
        } finally {await rm(temporary, {force: true});}
    }
    async read(reference: Pick<RegisteredToolPackage, 'id' | 'version' | 'fingerprint'>): Promise<RegisteredToolPackage> {
        const file = this.file(reference), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw packageError('TOOL_PACKAGE_BINDING_INVALID', 'Invalid implementation receipt');
        const record = JSON.parse(await readFile(file, 'utf8')) as RegisteredToolPackage;
        if (record.id !== reference.id || record.version !== reference.version || record.fingerprint !== reference.fingerprint || !Array.isArray(record.bindings))
            throw packageError('TOOL_PACKAGE_BINDING_INVALID', 'Implementation receipt identity mismatch');
        return record;
    }
}
async function syncParent(file: string): Promise<void> {
    const parent = await open(path.dirname(file), 'r'); try {await parent.sync();} finally {await parent.close();}
}
