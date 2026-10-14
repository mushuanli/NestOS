import { createSessionHost } from './host-ports';

/** Silent default for legacy standalone helpers; runtimes inject their own logger. */
export const log = createSessionHost().logger;
