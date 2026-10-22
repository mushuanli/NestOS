import type { IFileSystem } from '@itookit/vfs-core';
import { isModelOperation, type ModelDefaults } from '../contracts/model-defaults';

const SETTINGS_PATH = '/llm/.connection-settings.json';

/** Store one canonical map, while retaining the legacy chat default on first read. */
export class ModelDefaultStore {
    constructor(private readonly fs: IFileSystem) {}

    async read(): Promise<{ defaults: ModelDefaults; legacy?: string }> {
        const path = await this.fs.driver.resolvePath(SETTINGS_PATH);
        if (!path) return { defaults: {} };
        const raw = await this.fs.driver.readContent(path, { representation: 'bytes' });
        const data: unknown = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidDocument('Invalid model defaults document');
        const record = data as Record<string, unknown>;
        if (record.version === undefined && record.defaults === undefined) {
            if (record.defaultConnectionId !== undefined && typeof record.defaultConnectionId !== 'string') throw invalidDocument('Invalid legacy model default');
            return { defaults: {}, legacy: record.defaultConnectionId as string | undefined };
        }
        if (record.version !== 1 || !record.defaults || typeof record.defaults !== 'object' || Array.isArray(record.defaults)) throw invalidDocument('Unsupported model defaults format');
        const defaults: ModelDefaults = {};
        for (const [operation, id] of Object.entries(record.defaults)) {
            if (!isModelOperation(operation) || typeof id !== 'string' || !id.trim()) throw invalidDocument('Invalid model default binding');
            defaults[operation] = id;
        }
        return { defaults };
    }

    async write(defaults: ModelDefaults): Promise<void> {
        const content = JSON.stringify({ version: 1, defaults }, null, 2);
        const path = await this.fs.driver.resolvePath(SETTINGS_PATH);
        if (path) await this.fs.driver.writeContent(path, content);
        else await this.fs.driver.createFile({ name: '.connection-settings.json', parentPath: '/llm', content, recursive: true });
    }
}

function invalidDocument(message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code: 'MODEL_DEFAULT_SCHEMA_INVALID' });
}
