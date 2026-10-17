// @file: llm-ui/services/FileSearchService.ts

import { createVFSFileDiscoverySource, discoverFiles, guessMimeType } from '@itookit/vfs-core';
import type { FileDiscoveryOptions, IFileSystem } from '@itookit/vfs-core';
import type { FileSuggestion } from '../domain/types';

const guessMimeTypeFromName = guessMimeType;

export class FileSearchService {
    constructor(private fs?: IFileSystem) {}

    /** Search session-scoped files for @mention suggestions. */
    async search(query: string, options?: FileDiscoveryOptions): Promise<FileSuggestion[]> {
        try {
            if (!this.fs) return [];
            const results: FileSuggestion[] = [];
            const source = createVFSFileDiscoverySource(this.fs);
            for await (const node of discoverFiles(source, '/', options)) {
                if (node.type !== 'file' || !node.path.toLowerCase().includes(query.toLowerCase())) continue;
                results.push({ name: node.name, path: `.${node.path}`,
                    mimeType: guessMimeTypeFromName(node.name), size: node.size });
                if (results.length >= 20) break;
            }
            return results;
        } catch {
            return [];
        }
    }
}
