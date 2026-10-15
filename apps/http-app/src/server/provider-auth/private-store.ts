import { mkdir, readdir, readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export interface Registration {
    providerId: string; clientId: string; subject: string; email?: string;
    tokens?: { accessToken: string; refreshToken: string; idToken: string; scopes: string[]; expiresAt: number };
}

/** Private host storage is deliberately outside VFS, exports and static assets. */
export class PrivateAuthStore {
    private readonly records = new Map<string, Registration>();
    hostId = '';
    constructor(readonly directory: string) {}
    async initialize(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.checkPrivate(this.directory, true);
        const host = path.join(this.directory, 'host.json');
        try { this.hostId = JSON.parse(await this.readPrivate(host)).hostId; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid private OAuth host identity');
            this.hostId = `urn:uuid:${randomUUID()}`; await atomicJSON(host, { hostId: this.hostId });
        }
        if (!/^urn:uuid:[a-f0-9-]{36}$/.test(this.hostId)) throw new Error('Invalid private OAuth host identity');
        for (const file of await readdir(this.directory)) {
            if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
            let record: Registration;
            try { record = JSON.parse(await this.readPrivate(path.join(this.directory, file))) as Registration; }
            catch { throw new Error('Invalid private OAuth registration'); }
            if (!record.providerId || this.filename(record.providerId) !== path.join(this.directory, file)) throw new Error('Invalid OAuth registration');
            this.records.set(record.providerId, record);
        }
    }
    get(id: string): Registration | undefined { const record = this.records.get(id); return record && structuredClone(record); }
    async put(record: Registration): Promise<void> {
        await atomicJSON(this.filename(record.providerId), record);
        this.records.set(record.providerId, structuredClone(record));
    }
    private filename(id: string): string { return path.join(this.directory, createHash('sha256').update(id).digest('hex') + '.json'); }
    private async readPrivate(file: string): Promise<string> { await this.checkPrivate(file); return readFile(file, 'utf8'); }
    private async checkPrivate(file: string, directory = false): Promise<void> {
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
            || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
            throw new Error('OAuth storage must be private and owned by the host user');
        }
    }
}

async function atomicJSON(file: string, value: unknown): Promise<void> {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
        const directory = await open(path.dirname(file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
}
