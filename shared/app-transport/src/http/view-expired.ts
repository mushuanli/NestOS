import { FSError } from '@itookit/vfs-core';

/** Terminal transport state: existing capabilities must never be sent to a new view. */
export class ViewExpiredError extends FSError {
    constructor() { super('ECAPABILITY', 'View expired; reload the page'); }
}
