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

const imageFields = [{name: 'words', type: 'string' as const}, {name: 'images', type: 'json' as const, widget: 'images' as const,
    imageConstraints: {maxItems: 2, mimeTypes: ['image/jpeg']}}];
function mediaCommands(mimeType = 'image/jpeg') {
    return {execute: vi.fn(async (command: string, args: any) => command === 'app.resource.read'
        ? {kind: mimeType.startsWith('image/') ? 'image' : 'file', name: 'input.jpg', mimeType, bytes: 3, sha256: 'a'.repeat(64), data: new Uint8Array([255, 216, 255]).buffer}
        : {kind: 'input', id: args.uploadId, mimeType, bytes: 3, sha256: 'a'.repeat(64)})} as any;
}
it('routes positional images to the unique attachment parameter and appends subsequent references', async () => {
    const commands = mediaCommands();
    const result = await resolveFlowArguments('@/one.jpg @/two.jpg apple', imageFields, commands, {navigation: 'projects'});
    expect(result.words).toBe('apple');
    expect(result.images).toHaveLength(2);
    expect(result.images).toMatchObject([{type: 'image', source: {type: 'asset', asset: {kind: 'input'}}}, {type: 'image'}]);
    expect(commands.execute.mock.calls[0]).toEqual(['app.resource.read', {reference: '@/one.jpg', scope: {navigation: 'projects'}, mode: 'auto'}]);
});
it('rejects incompatible explicit bindings and ambiguous image targets without importing assets', async () => {
    const commands = mediaCommands();
    await expect(resolveFlowArguments('words=@/one.jpg', imageFields, commands, {navigation: 'projects'})).rejects.toMatchObject({code: 'FLOW_ARGUMENT_MEDIA_MISMATCH'});
    await expect(resolveFlowArguments('@/one.jpg', [...imageFields, {...imageFields[1], name: 'cover'}], commands, {navigation: 'projects'})).rejects.toMatchObject({code: 'FLOW_ARGUMENT_MEDIA_AMBIGUOUS'});
    expect(commands.execute.mock.calls.every(([command]: [string]) => command === 'app.resource.read')).toBe(true);
});
it('validates cumulative media bounds and keeps named attachment routing deterministic', async () => {
    await expect(resolveFlowArguments('@/one.jpg @/two.jpg @/three.jpg', imageFields, mediaCommands(), {navigation: 'projects'})).rejects.toMatchObject({code: 'FLOW_ARGUMENT_MEDIA_LIMIT'});
    const fields = [...imageFields, {...imageFields[1], name: 'cover'}];
    expect((await resolveFlowArguments('cover=@/one.jpg', fields, mediaCommands(), {navigation: 'projects'})).cover).toHaveLength(1);
    await expect(resolveFlowArguments('@/one.pdf', imageFields, mediaCommands('application/pdf'), {navigation: 'projects'})).rejects.toMatchObject({code: 'FLOW_ARGUMENT_MEDIA_UNSUPPORTED'});
});
it('wraps a referenced document as a file asset for a compatible file parameter', async () => {
    const fields = [{name: 'document', type: 'json' as const, widget: 'files' as const, fileConstraints: {mimeTypes: ['application/pdf']}}];
    expect((await resolveFlowArguments('@/one.pdf', fields, mediaCommands('application/pdf'), {navigation: 'projects'})).document)
        .toMatchObject([{type: 'file', source: {type: 'asset', asset: {mimeType: 'application/pdf'}}}]);
});
