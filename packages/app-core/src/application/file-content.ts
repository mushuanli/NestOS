import { FSError } from '@itookit/vfs-core';
import type { ApplicationFiles } from './files';
import type { ApplicationQueries, ApplicationCommands } from './contracts';

const maxContentBytes = 8 * 1024 * 1024;
export async function readApplicationFile(files: ApplicationFiles, query: ApplicationQueries['file']['input']) {
    return files.use(query.workspace, query.path, async (fs, path) => {
        let revision: string | undefined;
        const content = await fs.driver.readContent(path, { onRevision: value => { revision = value; } });
        if (query.encoding !== 'base64') {
            const text = typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: true }).decode(content);
            if (new TextEncoder().encode(text).byteLength > maxContentBytes) throw new FSError('EFBIG', 'File exceeds the editor limit');
            return { content: text, encoding: 'text' as const, revision };
        }
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
        if (bytes.length > maxContentBytes) throw new FSError('EFBIG', 'File exceeds the editor limit');
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        return { content: btoa(binary), encoding: 'base64' as const, revision };
    });
}
export async function saveApplicationFile(files: ApplicationFiles, request: ApplicationCommands['saveFile']['input']) {
    if (new TextEncoder().encode(request.content).byteLength > maxContentBytes) throw new FSError('EFBIG', 'File exceeds the editor limit');
    return files.use(request.workspace, request.path, async (fs, path) => {
        if (request.revision !== undefined) {
            const capabilities = await fs.capabilitiesAt(path);
            if (!('conditionalReplace' in capabilities) || capabilities.conditionalReplace !== true)
                throw new FSError('ECAPABILITY', 'The file source does not support revision preconditions');
        }
        let revision: string | undefined;
        await fs.driver.writeContent(path, request.content, { ifRevision: request.revision, onRevision: value => { revision = value; } });
        return { revision };
    });
}
