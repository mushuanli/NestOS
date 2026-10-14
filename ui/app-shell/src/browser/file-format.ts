import type { EditorOptions } from '@itookit/ui-common';
import { FILE_REGISTRY } from '../config/file-registry';

const markdownExtensions = new Set(['.md', '.markdown', '.mdx',
    ...Object.values(FILE_REGISTRY).filter(type => type.editorType === 'standard').map(type => type.extension)]);

/** Domain document aliases belong to the shell, not the generic editor package. */
export function fileContentFormat(path: string): Pick<EditorOptions, 'contentFormat'> {
    const name = path.split('/').pop() ?? '';
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    return { contentFormat: markdownExtensions.has(extension) ? 'markdown' : 'text' };
}
