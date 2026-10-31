import type {IFileSystem} from '@itookit/vfs-core';
import type {StudyDocuments} from '@itookit/mdxeditor';
import {createModuleLogger, randomUUID} from '@itookit/common';

/** Enumerate visible directory metadata only when the destination picker asks for it. */
export function createStudyDirectories(fs: IFileSystem): NonNullable<StudyDocuments['directories']> {
    return {list: async (parent = '/', signal) => {
        signal?.throwIfAborted(); const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('study-directories');
        try {
            const nodes = await fs.driver.getChildren(parent); signal?.throwIfAborted();
            const entries = nodes.filter(node => node.type === 'directory' && !node.name.startsWith('.'))
                .map(node => ({id: node.path, title: node.name, kind: 'directory' as const}));
            log.debug('study.directories', {operationId, stage: 'list', result: 'success', count: entries.length, durationMs: Date.now() - started});
            return entries;
        } catch (error) {
            const code = (error as {code?: string})?.code;
            log.warn('study.directories', {operationId, stage: 'list', result: 'failure', code: signal?.aborted ? 'CANCELLED'
                : code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'STUDY_DIRECTORY_READ_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }};
}
