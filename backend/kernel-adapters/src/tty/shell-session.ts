// @file: kernel-adapters/src/tty/shell-session.ts
// shell_session — spawn a persistent shell with bidirectional I/O.
//
// Unlike shell_exec (fire-and-forget), shell_session:
//   • Keeps the process alive between agent rounds
//   • Preserves working directory and environment across commands
//   • Accepts user/agent input via tty_write
//   • Emits real-time output events for the UI
//
// The agent calls shell_session once, uses tty_write to interact,
// and tty_close to terminate. The session ID links the calls.

import type { ToolMeta, ToolDefinition, ToolHandler, ITTYDriver, ITTYSessionManager } from '@itookit/tools/contracts';
import { collectOutput } from './session-manager';

export const shellSessionMeta: ToolMeta = {
    id:          'shell_session',
    name:        'Shell Session',
    description: 'Start a persistent interactive shell session. Use tty_write to send input, tty_close to end.',
    sideEffect:  'local',
    timeoutMs:   300_000, // 5 min hard limit for startup
    type:        'builtin',
    enabled:     true,
    tags:        ['shell', 'tty', 'interactive'],
};

export const shellSessionDefinition: ToolDefinition = {
    name: 'shell_session',
    description:
        'Start a persistent interactive shell session that preserves state (working directory, ' +
        'environment variables) between commands. Ideal for: interactive interpreters (python, node, ' +
        'psql), multi-step build processes, and commands that prompt for input.\n\n' +
        'Returns output until idle, then pauses. Use tty_write to send input, tty_close to terminate.\n\n' +
        'For single one-off commands use shell_exec instead.',
    parameters: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Executable to start (e.g., "bash", "python3", "psql", "node")',
            },
            args: {
                type:        'array',
                items:       { type: 'string' },
                description: 'Arguments passed to the command (optional)',
            },
            cwd: {
                type:        'string',
                description: 'Working directory (defaults to agent CWD)',
            },
            env: {
                type:                 'object',
                additionalProperties: { type: 'string' },
                description:          'Extra environment variables to merge with the process environment',
            },
            idle_timeout_ms: {
                type:        'number',
                description: 'Milliseconds of output silence before control is returned (default 1500)',
            },
        },
        required: ['command'],
    },
};

/**
 * Factory — closes over the TTY driver and session manager so the handler
 * can create and register sessions without a global singleton.
 */
export function createShellSessionHandler(
    driver:  ITTYDriver,
    manager: ITTYSessionManager,
    onEvent?: (type: string, payload: Record<string, unknown>) => void,
): ToolHandler {
    return async (args, ctx) => {
        const command      = args['command']          as string;
        const extraArgs    = (args['args']            as string[] | undefined) ?? [];
        const cwd          = (args['cwd']             as string  | undefined) ?? ctx.cwd;
        const env          = (args['env']             as Record<string, string> | undefined);
        const idleTimeout  = (args['idle_timeout_ms'] as number  | undefined) ?? 1_500;

        if (typeof command !== 'string' || !command.trim()) {
            throw new Error('TTY command is required');
        }
        if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== 'string')) {
            throw new Error('TTY args must be an array of strings');
        }
        if (!Number.isFinite(idleTimeout) || idleTimeout <= 0 || idleTimeout > 300_000) {
            throw new Error('TTY idle timeout must be between 1 and 300000 ms');
        }

        const session = driver.spawn(command, extraArgs, {
            cwd,
            env,
            signal: ctx.signal,
        });

        manager.add(session);
        onEvent?.('agent:tty:open', { sessionId: session.id, command: session.command, pid: session.pid });

        // Forward real-time data events
        const unsub = session.on('data', (chunk) => {
            onEvent?.('agent:tty:data', { sessionId: session.id, chunk });
        });

        const { output, exited, exitCode, truncated } =
            await collectOutput(session, { idleTimeoutMs: idleTimeout, signal: ctx.signal });

        unsub();

        if (exited) {
            onEvent?.('agent:tty:close', { sessionId: session.id, exitCode, signal: null });
            manager.remove(session.id);
        }

        return formatSessionResult(session.id, command, output, exited, exitCode, truncated);
    };
}

function formatSessionResult(
    sessionId: string,
    command:   string,
    output:    string,
    exited:    boolean,
    exitCode:  number | null,
    truncated: boolean,
): string {
    const lines: string[] = [
        `[TTY Session: ${sessionId}]`,
        `$ ${command}`,
        '',
    ];

    if (output) lines.push(output.trimEnd());

    if (exited) {
        lines.push('', `[Process exited with code ${exitCode ?? '?'}]`);
    } else {
        lines.push(
            '',
            `[Session paused — waiting for input]`,
            `[Use tty_write(session_id="${sessionId}", data="...") to continue]`,
            `[Use tty_close(session_id="${sessionId}") to terminate]`,
        );
    }

    if (truncated) lines.push('[Note: output was truncated]');

    return lines.join('\n');
}
