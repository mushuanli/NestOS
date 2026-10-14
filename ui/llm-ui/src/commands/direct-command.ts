import { t } from '@itookit/common';

/** Input policy shared by send, resend and edit-and-run; no I/O. */
export function parseDirectCommand(text: string, files: readonly unknown[]): string | undefined {
    const input = text.trimStart();
    if (!input.startsWith('!')) return undefined;
    const command = input.slice(1).trim();
    if (!command) throw new Error(t('chatInput.command.empty'));
    if (files.length) throw new Error(t('chatInput.command.attachments'));
    return command;
}

/** Execution mechanism: unsupported explicit commands never fall back to chat. */
export async function dispatchDirectCommand(text: string, files: readonly unknown[], exec?: (command: string) => Promise<void>): Promise<boolean> {
    const command = parseDirectCommand(text, files);
    if (command === undefined) return false;
    if (!exec) throw new Error(t('chatInput.command.unavailable'));
    await exec(command);
    return true;
}

/** The durable program that carries explicit shell input; other tasks have no command output. */
const DIRECT_COMMAND_PROGRAM = 'kernel-adapters.exec';

/** Structural view of a finished direct command task; this module performs no Kernel I/O. */
export interface DirectCommandTask {
    program?: { kind?: string };
    input?: unknown;
    status: string;
    exit?: { output?: unknown; error?: { message?: string } };
    effects?: Record<string, { error?: { message?: string } } | undefined>;
}

export interface DirectCommandOutcome {
    command: string;
    output: string;
    success: boolean;
    status: 'succeeded' | 'failed' | 'cancelled';
}

/**
 * Render-ready result of the attached exec task, or undefined when the task is not a
 * direct command or has not reached a terminal state. Output stays in the host UI: it is
 * never written back into the conversation.
 */
export function readDirectCommandOutcome(task: DirectCommandTask): DirectCommandOutcome | undefined {
    if (task.program?.kind !== DIRECT_COMMAND_PROGRAM) return undefined;
    if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') return undefined;
    const command = readCommand(task.input);
    if (task.status === 'succeeded') {
        const result = readToolResult(task.exit?.output);
        return { command, output: result.output, success: result.exitCode === 0, status: 'succeeded' };
    }
    return { command, output: task.exit?.error?.message ?? readEffectError(task) ?? '', success: false, status: task.status };
}

function readCommand(input: unknown): string {
    const command = (input as { command?: unknown } | undefined)?.command;
    return typeof command === 'string' ? command : '';
}

/** `exit.output` is `{ result: ToolInvokeResult }`; read the model-facing text and the real exit code. */
function readToolResult(output: unknown): { output: string; exitCode: number } {
    const result = (output as { result?: { output?: unknown; data?: { exitCode?: unknown } } } | undefined)?.result;
    const exitCode = typeof result?.data?.exitCode === 'number' ? result.data.exitCode : 0;
    return { output: typeof result?.output === 'string' ? result.output : '', exitCode };
}

/** Older records keep the failure on the effect instead of the task exit. */
function readEffectError(task: DirectCommandTask): string | undefined {
    for (const effect of Object.values(task.effects ?? {})) {
        if (effect?.error?.message) return effect.error.message;
    }
    return undefined;
}
