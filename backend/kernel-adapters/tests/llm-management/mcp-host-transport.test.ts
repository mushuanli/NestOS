import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { MCPServerConnection } from '../../src/llm-management/skills/mcp-client';
import { HostMCPTransport, createMCPStdioTransportFactory } from '../../src/llm-management/skills/mcp-host-transport';

it('runs the host bridge through SDK latest protocol discovery, capability discovery, content and progress', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/mcp-capabilities.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const lines: string[] = []; const input = createInterface({ input: child.stdout }); input.on('line', line => lines.push(line));
    const closed = new Promise<void>(resolve => child.on('close', () => resolve()));
    const stop = vi.fn(async () => { child.kill(); await closed; });
    const stdioTransport = createMCPStdioTransportFactory({ start: async () => 'native', send: (_id, line) => new Promise<void>((resolve, reject) => { child.stdin.write(line + '\n', error => error ? reject(error) : resolve()); }),
        poll: async () => ({ lines: lines.splice(0), exited: child.exitCode !== null, ...(child.exitCode !== null ? { error: stderr } : {}) }), stop });
    vi.stubGlobal('window', {});
    const client = new MCPServerConnection({ name: 'test', transport: 'stdio', command: 'node' }, { stdioTransport });
    try {
        await client.connect(); const catalog = await client.discover();
        expect(catalog).toMatchObject({ protocolVersion: '2026-07-28', capabilities: { tools: true, resources: true, prompts: true },
            resources: [{ uri: 'test://first' }, { uri: 'test://second' }], prompts: [{ name: 'review' }] });
        expect(await client.readResource('test://first')).toMatchObject({ contents: [{ text: 'RESOURCE_CONTENT' }] });
        expect(await client.getPrompt('review', { subject: 'code' })).toMatchObject({ messages: [{ content: { text: 'Review code' } }] });
        let done = false; const progress = vi.fn(() => { expect(done).toBe(false); });
        const result = await client.callTool('lookup', {}, { onProgress: progress }); done = true;
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, message: 'Searching' }));
        expect(result).toMatchObject({ content: [{ text: 'TOOL_RESULT' }] });
    } catch (error) { throw new Error(`Host bridge failed (${child.exitCode}): ${stderr}`, { cause: error }); }
    finally { await client.disconnect(); vi.unstubAllGlobals(); input.close(); child.kill(); await closed; }
    expect(stop).toHaveBeenCalledOnce();
});

it('closes a process whose asynchronous start finishes after cancellation', async () => {
    let release!: (id: string) => void; const stop = vi.fn(async () => {});
    const transport = new HostMCPTransport({ start: () => new Promise(resolve => { release = resolve; }), stop,
        send: async () => {}, poll: async () => ({ lines: [], exited: false }) }, { name: 'test', transport: 'stdio', command: 'node' });
    const starting = transport.start(), closing = transport.close(); release('late');
    await Promise.all([starting, closing]); expect(stop).toHaveBeenCalledWith('late');
});
