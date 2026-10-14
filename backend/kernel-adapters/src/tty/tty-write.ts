// @file: kernel-adapters/src/tty/tty-write.ts
// tty_write — send input to an active TTY session and collect the response.

import type { ToolMeta, ToolDefinition, ToolHandler, ITTYSessionManager } from '@itookit/tools/contracts';
import { collectOutput } from './session-manager';

export const ttyWriteMeta: ToolMeta = {
    id:          'tty_write',
    name:        'TTY Write',
    description: 'Send input to an active shell session and return the next output.',
    sideEffect:  'local',
    timeoutMs:   120_000,
    type:        'builtin',
    enabled:     true,
    tags:        ['tty', 'interactive'],
};

export const ttyWriteDefinition: ToolDefinition = {
    name: 'tty_write',
    description:
        'Send a string to an active TTY session created by shell_session. ' +
        'Use "\\n" or "\\r\\n" to simulate pressing Enter. ' +
        'Returns any new output produced by the process after receiving the input.',
    parameters: {
        type: 'object',
        properties: {
            session_id: {
                type:        'string',
                description: 'Session ID returned by shell_session',
            },
            data: {
                type:        'string',
                description: 'Data to write (use \\n for newline / Enter)',
            },
            idle_timeout_ms: {
                type:        'number',
                description: 'Milliseconds to wait for output after writing (default 1500)',
            },
        },
        required: ['session_id', 'data'],
    },
};

export function createTtyWriteHandler(
    manager:  ITTYSessionManager,
    onEvent?: (type: string, payload: Record<string, unknown>) => void,
): ToolHandler {
    return async (args, ctx) => {
        const sessionId   = args['session_id']       as string;
        const data        = args['data']             as string;
        const idleTimeout = (args['idle_timeout_ms'] as number | undefined) ?? 1_500;

        const session = manager.get(sessionId);
        if (!session) {
            throw new Error(`TTY session not found: ${sessionId}`);
        }
        if (session.exited) {
            throw new Error(`TTY session has exited: ${sessionId}`);
        }
        if (typeof data !== 'string' || data.length > 1_000_000) {
            throw new Error('TTY data must be a string no larger than 1 MB');
        }

        // Write and collect response
        session.write(data);

        const unsub = session.on('data', (chunk) => {
            onEvent?.('agent:tty:data', { sessionId, chunk });
        });

        const { output, exited, exitCode, truncated } =
            await collectOutput(session, { idleTimeoutMs: idleTimeout, signal: ctx.signal });

        unsub();

        if (exited) {
            onEvent?.('agent:tty:close', { sessionId, exitCode, signal: null });
            manager.remove(sessionId);
        }

        const lines: string[] = [`[TTY ${sessionId}]`];
        if (output) lines.push(output.trimEnd());

        if (exited) {
            lines.push('', `[Process exited with code ${exitCode ?? '?'}]`);
        } else {
            lines.push('', `[Waiting for more input — use tty_write or tty_close]`);
        }
        if (truncated) lines.push('[output truncated]');

        return lines.join('\n');
    };
}
