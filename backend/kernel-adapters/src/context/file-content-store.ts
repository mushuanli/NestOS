import { createContextContentStore, type IContextContentStore } from '@itookit/llm-context';
import type { IFileSystem } from '@itookit/vfs-core';

/** Content is immutable and scoped to the owning Task's Session storage. */
export function createFileContextContentStore(fs: IFileSystem, root: string, readRecords = true): IContextContentStore {
    const path = (id: string) => {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid context content identity');
        return `${root}/${id}`;
    };
    return createContextContentStore({
        async get(id) {
            const records = `${root.slice(0, root.lastIndexOf('/'))}/task.seq`;
            if (readRecords && fs.meta.seq && await fs.driver.exists(records)) {
                const body = await fs.meta.seq.getEntry(records, `context-content/blob/${id}`);
                if (body !== null) return body;
            }
            const target = path(id);
            if (!await fs.driver.exists(target)) return null;
            return fs.driver.readContent(target, { encoding: 'utf-8' });
        },
        async putIfAbsent(id, content) {
            const target = path(id);
            if (await fs.driver.exists(target)) return;
            try {
                await fs.driver.createFile({ parentPath: root, name: id, content, recursive: true, overwrite: false });
            } catch (error) {
                if (!await fs.driver.exists(target)) throw error;
                // Concurrent immutable publication is accepted only after the caller verifies bytes.
            }
        },
    });
}
