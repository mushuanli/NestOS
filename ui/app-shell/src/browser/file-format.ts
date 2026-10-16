import type { EditorOptions } from '@itookit/ui-common';
import { FILE_REGISTRY } from '../config/file-registry';

const markdownExtensions = new Set(['.md', '.markdown', '.mdx',
    ...Object.values(FILE_REGISTRY).filter(type => type.contentFormat === 'markdown').map(type => type.extension.toLowerCase())]);

/** Domain document aliases belong to the shell, not the generic editor package. */
export function fileContentFormat(path: string, types: import('./types').EditorFileType[] = []): Pick<EditorOptions, 'contentFormat'> {
    const name = path.split('/').pop() ?? '';
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    return { contentFormat: types.find(type => type.extensions.some(candidate => candidate.toLowerCase() === extension))?.contentFormat
        ?? (markdownExtensions.has(extension) ? 'markdown' : 'text') };
}
