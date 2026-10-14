import { FSError } from '@itookit/vfs-core';

/**
 * A Session still has non-terminal Tasks, so its mounts cannot change.
 *
 * The platform-agnostic layer raises a structured error; the host maps it to localized
 * text (`error.sessionUnfinishedTasks` in `@itookit/common`) instead of this package
 * owning user-facing copy.
 */
export class SessionUnfinishedTasksError extends FSError {
    constructor(readonly sessionId: string) {
        super('EBUSY', 'Session has unfinished Tasks', 'mount-guard');
        this.name = 'SessionUnfinishedTasksError';
    }
}

/**
 * A mounted directory source is gone; every content operation fails closed until the
 * host reconnects it. Hosts map this to localized text (`error.directorySourceUnavailable`).
 */
export class DirectorySourceUnavailableError extends FSError {
    constructor(readonly sourceId?: string) {
        super('EACCES', 'Directory source unavailable', 'directory-source');
        this.name = 'DirectorySourceUnavailableError';
    }
}
