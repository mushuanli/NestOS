import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import type { IFileSystem, IVFSManager } from '@itookit/vfs-core';
import type { LLMSkill } from '@itookit/kernel-adapters/contracts';
import { SkillManager } from '../../src/llm-management/device/skill-manager';
import { VFSHelpers } from '../../src/llm-management/device/vfs-helpers';
import type { MCPManager } from '../../src/llm-management/device/mcp-manager';

const validSkill: LLMSkill = {
    id: 'review',
    name: 'Review',
    description: '',
    type: 'prompt',
    enabled: true,
    instructions: '',
    tools: [{ toolId: 'inspect', executionType: 'builtin', definition: { name: 'inspect' } }],
    triggerPatterns: [],
    autoLoad: false,
    priority: 50,
};

describe('canonical Skill storage', () => {
    it('reads only YAML, isolates invalid definitions, rejects invalid saves before writing, and never probes legacy files during delete', async () => {
        const files = new Map([
            ['/llm/.skills/review.yaml', yaml.dump(validSkill)],
            ['/llm/.skills/comment-only.yaml', '# no skill fields\n'],
            ['/llm/.skills/missing-id.yaml', yaml.dump({ ...validSkill, id: undefined })],
            ['/llm/.skills/bad-tool-null.yaml', yaml.dump({ ...validSkill, id: 'bad-tool-null', tools: [null] })],
            ['/llm/.skills/bad-tool-shape.yaml', yaml.dump({ ...validSkill, id: 'bad-tool-shape', tools: [{ toolId: 'broken' }] })],
            ['/llm/.skills/bad-tool-definition.yaml', yaml.dump({ ...validSkill, id: 'bad-tool-definition', tools: [{ toolId: 'broken', executionType: 'builtin', definition: {} }] })],
            ['/llm/.skills/review.json', '{"id":"legacy-review"}'],
            ['/llm/.skills/old.json', '{"id":"old"}'],
            ['/llm/.skills/alternate.yml', 'id: alternate'],
        ]);
        const resolvePath = vi.fn(async (path: string) => path === '/llm/.skills' || files.has(path) ? path : null);
        const readContent = vi.fn(async (path: string) => files.get(path)!);
        const createFile = vi.fn(async (options: { name: string; parentPath: string; content: string | ArrayBuffer }) => {
            const content = typeof options.content === 'string' ? options.content : new TextDecoder().decode(options.content);
            files.set(`${options.parentPath === '/' ? '' : options.parentPath}/${options.name}`, content);
        });
        const fs = { driver: {
            resolvePath, readContent, createFile,
            getChildren: async () => [...files.keys()].map(path => ({ path, name: path.split('/').pop(), type: 'file' })),
            writeContent: async (path: string, content: string) => { files.set(path, content); },
            delete: async (paths: string[]) => { paths.forEach(path => files.delete(path)); },
        } } as unknown as IFileSystem;
        const helpers = new VFSHelpers(fs);
        const createDeviceNode = vi.fn(async () => {});
        const removeDeviceNode = vi.fn(async () => {});
        const onChanged = vi.fn();
        const manager = new SkillManager(helpers, {
            createDeviceNode, removeDeviceNode,
        } as unknown as IVFSManager, {} as MCPManager, undefined, onChanged);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await manager.reload();
            expect(manager.getSkills().map(skill => skill.id)).toEqual(['review']);
            expect(manager.findSkill('review')?.name).toBe('Review');
            expect(manager.findSkill('comment-only')).toBeUndefined();
            expect(manager.findSkill('missing-id')).toBeUndefined();
            expect(manager.findSkill('bad-tool-null')).toBeUndefined();
            expect(manager.findSkill('bad-tool-shape')).toBeUndefined();
            expect(manager.findSkill('bad-tool-definition')).toBeUndefined();
            // Invalid definitions injected through the cache API are isolated too,
            // so createDeviceNodes() never reads an id from a malformed entry.
            manager.setSkills([
                null as unknown as LLMSkill,
                { ...validSkill, id: 'bad-cache-tool', tools: [null] } as unknown as LLMSkill,
                validSkill,
            ]);
            expect(manager.getRawSkills()).toEqual([validSkill]);
            expect(readContent.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
                '/llm/.skills/review.yaml',
                '/llm/.skills/comment-only.yaml',
                '/llm/.skills/missing-id.yaml',
                '/llm/.skills/bad-tool-null.yaml',
                '/llm/.skills/bad-tool-shape.yaml',
                '/llm/.skills/bad-tool-definition.yaml',
            ]));
            expect(readContent.mock.calls.every(call => !call[0].endsWith('.json') && !call[0].endsWith('.yml'))).toBe(true);
            for (const path of ['comment-only', 'missing-id', 'bad-tool-null', 'bad-tool-shape', 'bad-tool-definition']) {
                expect(warn).toHaveBeenCalledWith(expect.stringContaining(`/llm/.skills/${path}.yaml`));
            }

            const cacheBeforeInvalidSave = manager.getSkills();
            const createNodesBeforeInvalidSave = createDeviceNode.mock.calls.length;
            const removeNodesBeforeInvalidSave = removeDeviceNode.mock.calls.length;
            const changedBeforeInvalidSave = onChanged.mock.calls.length;
            await expect(manager.saveSkill({ ...validSkill, id: 'bad-save', tools: [null] } as unknown as LLMSkill))
                .rejects.toThrow(/Invalid skill definition/);
            expect(files.has('/llm/.skills/bad-save.yaml')).toBe(false);
            expect(manager.getSkills()).toEqual(cacheBeforeInvalidSave);
            expect(createDeviceNode).toHaveBeenCalledTimes(createNodesBeforeInvalidSave);
            expect(removeDeviceNode).toHaveBeenCalledTimes(removeNodesBeforeInvalidSave);
            expect(onChanged).toHaveBeenCalledTimes(changedBeforeInvalidSave);

            await manager.saveSkill({ ...validSkill, name: 'Updated' });
            await manager.reload();
            expect(manager.findSkill('review')?.name).toBe('Updated');

            await manager.deleteSkill('review');
            await manager.reload();
            expect(manager.getSkills()).toEqual([]);
            expect(files.get('/llm/.skills/review.json')).toBe('{"id":"legacy-review"}');
            expect(resolvePath.mock.calls.every(call => !call[0].endsWith('.json'))).toBe(true);
            // JSON remains a native format for the other configuration collections.
            expect(await helpers.loadJsonFilesFromDir('/llm/.skills')).toHaveLength(files.size - 1);
        } finally {
            warn.mockRestore();
        }
    });
});
