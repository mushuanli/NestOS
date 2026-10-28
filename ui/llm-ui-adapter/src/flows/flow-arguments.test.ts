import {expect, it, vi} from 'vitest';
import {parseResourceReference} from '@itookit/app-contracts';
import {resolveFlowArguments} from './flow-arguments';
const fields = [{name: 'requirements', type: 'string' as const}, {name: 'essay', type: 'string' as const}, {name: 'rounds', type: 'number' as const}];
it('binds ordered and named file references without evaluating source content', async () => {
    const execute = vi.fn(async ({}, input: any) => ({text: input.reference.includes('require') ? '${param.essay}' : 'article'}));
    const commands = {execute} as any;
    expect(await resolveFlowArguments('@notes:/require.md @"//Project name/article.md" rounds=2', fields, commands, {navigation: 'projects'}))
        .toEqual({requirements: '${param.essay}', essay: 'article', rounds: 2});
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(resolveFlowArguments('essay=x essay=y', fields, commands, {navigation: 'projects'})).rejects.toThrow('Duplicate');
});
it('rejects ambiguous paths, bad quotes and unreadable files', async () => {
    expect(parseResourceReference('@"//Project/file name.md"')).toEqual({root: 'navigation', path: '/Project/file name.md'});
    expect(() => parseResourceReference('@notes:/../private/x')).toThrow('RESOURCE_PATH_INVALID');
    const commands = {execute: vi.fn(async () => {throw new Error('Access denied');})} as any;
    await expect(resolveFlowArguments('@notes:/missing', fields, commands, {navigation: 'projects'})).rejects.toThrow('Access denied');
    await expect(resolveFlowArguments('"broken', fields, commands, {navigation: 'projects'})).rejects.toThrow('QUOTES');
});
