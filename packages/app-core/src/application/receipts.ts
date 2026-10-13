import { FSError, type IFileSystem } from '@itookit/vfs-core';
import { sha256HexSync } from '@itookit/llm-context';
import type { JsonValue } from '@itookit/durable-kernel';
import type { CommandReceipt } from './contracts';

interface StoredReceipt extends CommandReceipt { digest: string }

/** Claims and outcomes are durable; an interrupted claim is never silently executed again. */
export class CommandReceipts {
    private ready?: Promise<IFileSystem>;
    private readonly pending = new Map<string, { digest: string; promise: Promise<unknown> }>();
    constructor(private readonly open: () => Promise<IFileSystem>) {}
    private files(): Promise<IFileSystem> {
        return this.ready ??= this.open().then(async fs => {
            if (!fs.meta.seq?.transaction) throw new FSError('ECAPABILITY', 'Command receipts require record transactions');
            if (!await fs.driver.getNode('/commands.seq')) {
                try { await fs.driver.createFile({ parentPath: '/', name: 'commands.seq', content: '' }); }
                catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
            }
            return fs;
        });
    }
    private key(identity: string, id: string): string {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new FSError('EINVAL', 'Invalid command identity');
        return sha256HexSync(identity) + ':' + id;
    }
    async read(identity: string, id: string): Promise<CommandReceipt | null> {
        const fs = await this.files(), raw = await fs.meta.seq!.getEntry('/commands.seq', this.key(identity, id));
        if (raw === null) return null;
        const { digest: _digest, ...receipt } = JSON.parse(String(raw)) as StoredReceipt;
        return receipt;
    }
    execute<T>(identity: string, id: string, name: string, input: unknown, run: () => Promise<T>): Promise<T> {
        const key = this.key(identity, id), digest = sha256HexSync(JSON.stringify({ name, input }));
        const existing = this.pending.get(key);
        if (existing) {
            if (existing.digest !== digest) return Promise.reject(new FSError('ECONFLICT', 'Command identity belongs to another request'));
            return existing.promise as Promise<T>;
        }
        const promise = this.run(key, id, name, digest, run);
        this.pending.set(key, { digest, promise });
        void promise.finally(() => this.pending.delete(key)).catch(() => {});
        return promise;
    }
    private async claim(key: string, id: string, name: string, digest: string, createdAt: number): Promise<StoredReceipt | null> {
        const fs = await this.files();
        return fs.meta.seq!.transaction!(async tx => {
            const raw = await tx.getEntry('/commands.seq', key);
            if (raw !== null) return JSON.parse(String(raw)) as StoredReceipt;
            await tx.setEntry('/commands.seq', key, JSON.stringify({ id, name, digest, state: 'pending', createdAt }));
            return null;
        });
    }
    private async run<T>(key: string, id: string, name: string, digest: string, run: () => Promise<T>): Promise<T> {
        const createdAt = Date.now(), previous = await this.claim(key, id, name, digest, createdAt);
        if (previous) {
            if (previous.digest !== digest) throw new FSError('ECONFLICT', 'Command identity belongs to another request');
            if (previous.state === 'completed') return previous.result as T;
            throw new FSError(previous.error?.code ?? 'ECONFLICT', previous.error?.message ?? 'Command outcome is pending');
        }
        let receipt: StoredReceipt;
        try { receipt = { id, name, digest, state: 'completed', result: (await run() ?? null) as JsonValue, createdAt }; }
        catch (error) {
            receipt = { id, name, digest, state: 'failed', createdAt, error: {
                code: error instanceof FSError ? error.code : 'EIO', message: error instanceof FSError ? error.message : 'Application command failed',
            } };
            await this.save(key, receipt); throw error;
        }
        await this.save(key, receipt); return receipt.result as T;
    }
    private async save(key: string, receipt: StoredReceipt): Promise<void> {
        const fs = await this.files(); await fs.meta.seq!.setEntry('/commands.seq', key, JSON.stringify(receipt));
    }
}
