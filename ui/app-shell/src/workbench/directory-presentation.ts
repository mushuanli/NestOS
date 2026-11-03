import { t, getLocale, ACTION_ICONS, FILE_BROWSER_ICONS, FILE_ICONS, VFS_TOOLBAR_ICONS, fileTypeIcon, createModuleLogger, randomUUID } from '@itookit/common';
import type { DirectoryPresentationOptions } from '@itookit/vfs-ui';

/** Translate and classify business resources without adding application dependencies to vfs-ui. */
export function directoryPresentation(): DirectoryPresentationOptions {
    return {trace: traceDirectory, locale: getLocale(), t: (key, params) => t(key === 'clearSearch' ? 'project.search.clear' : `workbench.${key}`, params),
        icons: {up: FILE_BROWSER_ICONS.up, refresh: FILE_BROWSER_ICONS.refresh, close: FILE_BROWSER_ICONS.close,
            search: ACTION_ICONS.search, more: FILE_BROWSER_ICONS.more, favorite: ACTION_ICONS.favorite},
        fileIcon: fileTypeIcon,
        entryType: entry => entry.type === 'session' ? t('workbench.session')
            : entry.name.split('.').slice(1).pop()?.toUpperCase() || t('workbench.file')};
}
export function directoryBulkIcon(id: string): string | undefined {
    if (id === 'copy') return FILE_ICONS.document;
    if (id === 'export') return VFS_TOOLBAR_ICONS.export;
    if (id === 'move') return FILE_BROWSER_ICONS.move;
    if (id === 'delete') return FILE_BROWSER_ICONS.delete;
    return undefined;
}

const logger = createModuleLogger('directory-view');
async function traceDirectory<T>(operation: string, work: () => Promise<T>): Promise<T> {
    const operationId = randomUUID(), started = Date.now();
    logger.debug(operation, {operationId, stage: 'start', result: 'pending'});
    try {
        const value = await work();
        logger.debug(operation, {operationId, stage: 'complete', result: 'success', durationMs: Date.now() - started});
        return value;
    } catch (error) {
        logger.warn(operation, {operationId, stage: 'complete', result: 'failure', durationMs: Date.now() - started, code: directoryErrorCode(error)});
        throw error;
    }
}
function directoryErrorCode(error: unknown): string {
    const seen = new Set<unknown>();
    let reason = 'DIRECTORY_OPERATION_FAILED';
    while (error instanceof Error && !seen.has(error)) {
        seen.add(error);
        const code = (error as {code?: unknown}).code;
        if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) reason = code;
        error = error.cause;
    }
    return reason;
}
