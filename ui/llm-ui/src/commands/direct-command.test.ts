import { expect, it, vi } from 'vitest';
import { dispatchDirectCommand, readDirectCommandOutcome } from './direct-command';

it('dispatches explicit shell text unchanged without handling ordinary chat', async () => {
    const exec = vi.fn(async () => {});
    expect(await dispatchDirectCommand('  !ls ../reference && printf "%s" "$HOME"', [], exec)).toBe(true);
    expect(exec).toHaveBeenCalledWith('ls ../reference && printf "%s" "$HOME"');
    expect(await dispatchDirectCommand('Explain !ls', [], exec)).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
});

it('rejects unsupported commands instead of falling back to chat', async () => {
    const exec = vi.fn(async () => {});
    await expect(dispatchDirectCommand('!', [], exec)).rejects.toThrow();
    await expect(dispatchDirectCommand('!ls', [{}], exec)).rejects.toThrow();
    await expect(dispatchDirectCommand('!ls', [])).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
});

it('preserves execution failure for the caller to restore input and report it', async () => {
    const failure = new Error('Process capability unavailable');
    await expect(dispatchDirectCommand('!ls', [], async () => { throw failure; })).rejects.toBe(failure);
});

it('exposes real stdout and exit code of a finished direct command', () => {
    expect(readDirectCommandOutcome({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'ls' }, status: 'succeeded',
        exit: { output: { result: { toolId: 'Bash', success: true, output: '[exit 0]\nfile.txt\n', data: { stdout: 'file.txt\n', exitCode: 0 } } } } }))
        .toEqual({ command: 'ls', output: '[exit 0]\nfile.txt\n', success: true, status: 'succeeded' });
    expect(readDirectCommandOutcome({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'grep missing .' }, status: 'succeeded',
        exit: { output: { result: { output: '[exit 1]\n', data: { exitCode: 1 } } } } }))
        .toMatchObject({ output: '[exit 1]\n', success: false });
});

it('reports the durable failure message instead of failing silently', () => {
    expect(readDirectCommandOutcome({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'ls' }, status: 'failed',
        exit: { error: { message: 'Execution backend unavailable' } } }))
        .toEqual({ command: 'ls', output: 'Execution backend unavailable', success: false, status: 'failed' });
    expect(readDirectCommandOutcome({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'ls' }, status: 'failed',
        effects: { exec: { error: { message: 'Legacy effect failure' } } } }))
        .toMatchObject({ output: 'Legacy effect failure', success: false });
    expect(readDirectCommandOutcome({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'ls' }, status: 'cancelled' }))
        .toEqual({ command: 'ls', output: '', success: false, status: 'cancelled' });
});

it('leaves non-command tasks and unfinished tasks to their own presenters', () => {
    expect(readDirectCommandOutcome({ program: { kind: 'llm.plan' }, input: { goal: 'ls' }, status: 'succeeded' })).toBeUndefined();
    expect(readDirectCommandOutcome({ program: { kind: 'kernel-adapters.exec' }, input: { command: 'ls' }, status: 'running' })).toBeUndefined();
});
