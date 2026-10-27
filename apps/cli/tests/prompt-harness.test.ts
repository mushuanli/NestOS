import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { promptCommand } from '../src/commands';

afterEach(() => { vi.unstubAllGlobals(); delete process.env.NESTOS_PROMPT_TEST_KEY; });

it.each([{ noTools: false, includeIgnored: false }, { noTools: false, includeIgnored: true },
    { noTools: true, includeIgnored: false }])('runs a quick prompt with real Session files (%j)', async ({ noTools, includeIgnored }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cli-prompt-tools-'));
    const workspace = path.join(root, 'project');
    await mkdir(path.join(workspace, 'node_modules'), { recursive: true });
    await writeFile(path.join(workspace, '.gitignore'), 'git-hidden.txt');
    await writeFile(path.join(workspace, '.nestosignore'), 'ai-hidden.txt');
    await writeFile(path.join(workspace, 'git-hidden.txt'), 'git-filtered mdx content');
    await writeFile(path.join(workspace, 'ai-hidden.txt'), 'ai-filtered mdx content');
    await writeFile(path.join(workspace, 'source.txt'), 'actual mdx evidence');
    await writeFile(path.join(workspace, 'node_modules', 'dep.txt'), 'ignored mdx dependency');
    await writeFile(path.join(root, 'outside.txt'), 'outside mdx secret');
    await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'escape.txt'));
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        requests.push(JSON.parse(options.body));
        const tool = !noTools && requests.length === 1;
        const delta = tool ? { role: 'assistant', reasoning_content: 'Inspect files.', tool_calls: [
            { index: 0, id: 'grep', type: 'function', function: { name: 'Grep', arguments: JSON.stringify({ pattern: 'mdx', path: '.', includeIgnored }) } },
        ] } : { role: 'assistant', content: 'done' };
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } });
    }));
    process.env.NESTOS_PROMPT_TEST_KEY = 'test';
    try {
        expect(await promptCommand({ prompt: 'current dir which file include mdx string?', noTools,
            apiKeyEnv: 'NESTOS_PROMPT_TEST_KEY', baseUrl: 'http://mock', model: 'mock',
            setHome: workspace, stateDir: path.join(root, 'state'), json: true })).toBe(0);
        expect(requests).toHaveLength(noTools ? 1 : 2);
        if (noTools) expect(requests[0].tools ?? []).toEqual([]);
        else {
            expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
            const assistant = requests[1].messages.find((message: any) => message.role === 'assistant');
            expect(assistant).toMatchObject({ tool_calls: [{ id: 'grep' }], reasoning_content: 'Inspect files.' });
            const result = requests[1].messages.find((message: any) => message.role === 'tool');
            expect(result.content).toContain('/workspace/source.txt');
            expect(result.content).toContain('actual mdx evidence');
            expect(result.content).not.toContain('outside mdx');
            for (const text of ['ignored mdx', 'git-filtered mdx', 'ai-filtered mdx']) {
                expect(result.content.includes(text)).toBe(includeIgnored);
            }
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
