import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_TOOLS } from '../index';
import type { INativeShell } from '../core/types';
import { ToolDeviceDriver } from './tool-device-driver';

function shellSpy(calls: string[]): INativeShell {
    return {
        capabilities: { ripgrep: false, fd: false },
        async exec(command, args) {
            calls.push(`${command} ${args.join(' ')}`);
            return { stdout: 'ok', stderr: '', code: 0 };
        },
    };
}

const toolNames = (driver: ToolDeviceDriver): string[] =>
    driver.getToolDefinitions().map(definition => definition.function?.name ?? definition.name ?? '');

it('advertises built-in tools with function schemas and initialized descriptions', async () => {
    const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
    await driver.init();
    const definitions = driver.getToolDefinitions();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
        expect(definition).toMatchObject({ type: 'function', function: {
            name: expect.any(String), description: expect.any(String), parameters: { type: 'object' },
        } });
        expect(definition.function!.description).not.toBe('');
    }
    const grep = definitions.find(definition => definition.function?.name === 'Grep');
    expect(grep?.function?.parameters?.required).toContain('pattern');
});

describe('ToolDeviceDriver.setNativeShell', () => {
    it('advertises Bash only after a native shell is injected', async () => {
        const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
        await driver.init();
        expect(toolNames(driver)).not.toContain('Bash');

        driver.setNativeShell(shellSpy([]));
        await driver.init();
        expect(toolNames(driver)).toContain('Bash');
        expect(driver.getToolMeta('Bash')?.enabled).toBe(true);
    });

    it('runs the injected shell through the advertised tool', async () => {
        const calls: string[] = [];
        const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
        driver.setNativeShell(shellSpy(calls));
        await driver.init();

        const result = await driver.invoke({ toolId: 'Bash', args: { command: 'echo ok' }, cwd: '/' });

        expect(calls).toEqual(['sh -c echo ok']);
        expect(result.success).toBe(true);
        expect(result.output).toContain('[exit 0]');
    });
});

it('streams Bash output before completion and retains the final result separately', async () => {
    let release!: () => void;
    const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
    driver.setNativeShell({ capabilities: { ripgrep: false, fd: false }, exec: async (_command, _args, options) => {
        options?.onOutput?.({ stream: 'stdout', text: 'early output' });
        await new Promise<void>(resolve => { release = resolve; });
        return { stdout: 'early output and final', stderr: '', code: 0 };
    } });
    await driver.init(); const progress = vi.fn(async () => {});
    const running = driver.invoke({ toolId: 'Bash', args: { command: 'test command' }, cwd: '/workspace', onProgress: progress });
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining({ output: 'early output' })));
    release(); const result = await running;
    expect(result.output).toContain('early output and final'); expect(result.success).toBe(true);
    await driver.dispose();
});
