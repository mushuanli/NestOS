import {expect, it, vi} from 'vitest';
import {ResourceCommand} from '@itookit/app-contracts';
import {expandComposerReferences} from './composer-references';
const scope = {navigation: 'projects', projectId: 'project'};
it('fills declared text with referenced file contents, preserves prose and reads repeated references once', async () => {
    const execute = vi.fn(async () => ({kind: 'text', text: 'document ${param.other} @/nested.md', bytes: 35}));
    const signal = new AbortController().signal;
    expect(await expandComposerReferences('Summarize @/notes.md and @/notes.md ; mail a@b.com', {execute} as never, scope, signal, 'operation'))
        .toBe('Summarize document ${param.other} @/nested.md and document ${param.other} @/nested.md ; mail a@b.com');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(ResourceCommand.Read, {reference: '@/notes.md', scope, mode: 'auto'});
});
it('keeps ordinary prose and supports quoted cross-project references', async () => {
    const execute = vi.fn(async () => ({text: 'quoted document'}));
    expect(await expandComposerReferences('Text @"//Project name/doc.md" end', {execute} as never, scope, new AbortController().signal, 'operation'))
        .toBe('Text quoted document end');
    execute.mockClear();
    expect(await expandComposerReferences('Email a@b.com and @someone', {execute} as never, scope, new AbortController().signal, 'operation')).toBe('Email a@b.com and @someone');
    expect(execute).not.toHaveBeenCalled();
});
it('propagates read failures and cancellation without falling back to unresolved references', async () => {
    const execute = vi.fn(async () => {throw Object.assign(new Error('Resource unavailable'), {code: 'ENOENT'});});
    await expect(expandComposerReferences('@/missing.md', {execute} as never, scope, new AbortController().signal, 'operation')).rejects.toMatchObject({code: 'ENOENT'});
    const abort = new AbortController(); execute.mockImplementation(async () => {abort.abort(); return {text: 'late'} as never;});
    await expect(expandComposerReferences('@/late.md', {execute} as never, scope, abort.signal, 'operation')).rejects.toMatchObject({name: 'AbortError'});
});
