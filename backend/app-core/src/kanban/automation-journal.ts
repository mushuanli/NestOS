import type {IFileSystem} from '@itookit/vfs-core';
import {sha256HexSync} from '@itookit/common';
import type {KanbanArtifactRef} from '@itookit/kanban/contracts';
import {requireValue} from './validation';

const path = '/var/lib/kanban/automation.seq';
export class KanbanAutomationJournal {
    private readonly writes = new Set<Promise<unknown>>();
    constructor(private readonly fs: IFileSystem) {}
    async open(): Promise<void> {
        try {await this.fs.driver.createFile({parentPath: '/var/lib/kanban', name: 'automation.seq', type: 'seqfile', recursive: true});}
        catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
        requireValue(this.fs.meta.seq?.transaction, 'TRANSACTION_REQUIRED');
    }
    async get<T>(key: string): Promise<T | undefined> {
        const raw = await this.fs.meta.seq!.getEntry(path, key); return raw ? JSON.parse(raw) as T : undefined;
    }
    async find<T>(keyPrefix: string, matches: (value: T, key: string) => boolean): Promise<Array<{key: string; value: T}>> {
        const rows: Array<{key: string; value: T}> = [];
        await this.fs.meta.seq!.walkEntries(path, entry => {
            const value = JSON.parse(entry.value) as T;
            if (matches(value, entry.key)) rows.push({key: entry.key, value});
            requireValue(rows.length <= 1000, 'SESSION_RELATION_LIMIT'); return true;
        }, {keyPrefix});
        return rows;
    }
    update<T>(key: string, change: (previous: T | undefined) => T): Promise<T> {
        const pending = this.commit(key, change).finally(() => {this.writes.delete(pending);});
        this.writes.add(pending); return pending;
    }
    async drain(): Promise<void> {await Promise.allSettled([...this.writes]);}
    claim(key: string): Promise<boolean> {
        const pending = this.fs.meta.seq!.transaction!(async tx => {
            const raw = await tx.getEntry(path, key); requireValue(raw, 'AUTOMATION_JOURNAL_MISSING');
            const record = JSON.parse(raw) as {phase: string};
            if (record.phase !== 'prepared') return false;
            await tx.setEntry(path, key, JSON.stringify({...record, phase: 'submitting'})); return true;
        }).finally(() => {this.writes.delete(pending);});
        this.writes.add(pending); return pending;
    }
    private async commit<T>(key: string, change: (previous: T | undefined) => T): Promise<T> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const raw = await tx.getEntry(path, key), value = change(raw ? JSON.parse(raw) as T : undefined);
            await tx.setEntry(path, key, JSON.stringify(value)); return structuredClone(value);
        });
    }
    async artifact(dispatchId: string, value: unknown): Promise<KanbanArtifactRef[]> {
        const text = JSON.stringify(value ?? null), bytes = new TextEncoder().encode(text).byteLength;
        requireValue(bytes <= 1024 * 1024, 'AUTOMATION_OUTPUT_TOO_LARGE');
        const sha256 = sha256HexSync(text);
        await this.update<string>('artifact:' + sha256, previous => {requireValue(previous === undefined || previous === text, 'ARTIFACT_CONFLICT'); return text;});
        const outputs = [{name: 'result', ref: 'nestos-kanban-artifact:' + sha256, sha256, bytes}];
        await this.update<KanbanArtifactRef[]>('artifact-owner:' + dispatchId, previous => {
            requireValue(!previous || JSON.stringify(previous) === JSON.stringify(outputs), 'ARTIFACT_CONFLICT'); return outputs;
        });
        return outputs;
    }
    async verify(outputs: KanbanArtifactRef[], dispatchId?: string): Promise<boolean> {
        if (dispatchId && JSON.stringify(await this.get('artifact-owner:' + dispatchId)) !== JSON.stringify(outputs)) return false;
        for (const output of outputs) {
            if (output.ref !== 'nestos-kanban-artifact:' + output.sha256) return false;
            const text = await this.get<string>('artifact:' + output.sha256);
            if (text === undefined || sha256HexSync(text) !== output.sha256 || new TextEncoder().encode(text).byteLength !== output.bytes) return false;
        }
        return true;
    }
}
