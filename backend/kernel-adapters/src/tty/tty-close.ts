// @file: kernel-adapters/src/tty/tty-close.ts
// tty_close — terminate an active TTY session gracefully.

import type { ToolMeta, ToolDefinition, ToolHandler, ITTYSessionManager } from '@itookit/tools/contracts';

export const ttyCloseMeta: ToolMeta = {
    id:          'tty_close',
    name:        'TTY Close',
    description: 'Terminate an active shell session.',
    sideEffect:  'local',
    timeoutMs:   10_000,
    type:        'builtin',
    enabled:     true,
    tags:        ['tty', 'interactive'],
};

export const ttyCloseDefinition: ToolDefinition = {
    name: 'tty_close',
    description:
        'Terminate a TTY session created by shell_session. ' +
        'Sends a signal to the process and removes the session.',
    parameters: {
        type: 'object',
        properties: {
            session_id: {
                type:        'string',
                description: 'Session ID to close',
            },
            signal: {
                type:        'string',
                description: 'Signal to send (default SIGTERM; use SIGKILL for force-quit)',
                enum:        ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'],
            },
        },
        required: ['session_id'],
    },
};

export function createTtyCloseHandler(
    manager:  ITTYSessionManager,
    onEvent?: (type: string, payload: Record<string, unknown>) => void,
): ToolHandler {
    return async (args) => {
        const sessionId = args['session_id'] as string;
        const signal    = (args['signal'] as string | undefined) ?? 'SIGTERM';
        if (!['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'].includes(signal)) {
            throw new Error(`Unsupported TTY signal: ${signal}`);
        }

        const session = manager.get(sessionId);
        if (!session) {
            return `TTY session "${sessionId}" not found (already closed or never created).`;
        }

        if (!session.exited) {
            session.kill(signal);
        }

        manager.remove(sessionId);

        onEvent?.('agent:tty:close', {
            sessionId,
            exitCode: session.exitCode,
            signal,
        });

        return `TTY session "${sessionId}" closed (signal: ${signal}, exit code: ${session.exitCode ?? 'unknown'}).`;
    };
}
