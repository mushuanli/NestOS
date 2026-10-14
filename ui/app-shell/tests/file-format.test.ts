import { expect, it } from 'vitest';
import { fileContentFormat } from '../src/browser/file-format';

it('preserves registered Markdown aliases and treats other files as source text', () => {
    for (const path of ['/AGENTS.md', '/notes.MD', '/a.markdown', '/a.mdx', '/lesson.prj', '/notes.mind', '/a.anki', '/a.email', '/a.private']) {
        expect(fileContentFormat(path)).toEqual({ contentFormat: 'markdown' });
    }
    for (const path of ['/pnpm-lock.yaml', '/package.json', '/error.log', '/a.txt', '/LICENSE', '/.gitignore', '/a.flow', '/a.agent']) {
        expect(fileContentFormat(path)).toEqual({ contentFormat: 'text' });
    }
});
