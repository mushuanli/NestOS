// @file: device-tty/src/index.ts
// @itookit/device-tty — TTY device driver for interactive shell sessions.

export { NodeTTYDriver } from './node-tty-driver';
export type { NodeTTYSession } from './node-tty-driver';
export { NodePtyDriver } from './node-pty-driver';
export type { NodePtySession } from './node-pty-driver';
export { TTYSessionManager, collectOutput } from './session-manager';

export type { ITTYSpawnOptions, ITTYSessionEvents, ITTYSession, ITTYDriver, ITTYSessionManager, TTYOutputResult } from '@itookit/tools/contracts';
