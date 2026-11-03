import type {IFileSystem} from '@itookit/vfs-core';
import {initializeFileExchange} from '../run/file-exchange-protocol';
/** Business methods are declared by the product adapter, never by Cells or the mailbox transport. */
export function initializeDevelopmentExchange(fs: IFileSystem, directory: string, scopeId: string): Promise<void> {
    return initializeFileExchange(fs, directory, scopeId, [{name: 'kanban.context.resolve', params: {
        repository: '.', commits: ['<full-commit-sha>'], include: ['task', 'decisions', 'acceptance'],
    }}]);
}
