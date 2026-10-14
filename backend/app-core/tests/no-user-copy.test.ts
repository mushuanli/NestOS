import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await sourceFiles(full));
        else if (entry.name.endsWith('.ts')) files.push(full);
    }
    return files;
}

/**
 * The platform-agnostic layer raises structured errors or uses `t()` keys whose copy
 * lives in `@itookit/common`; it must not hardcode user-facing text.
 */
describe('app-core user-facing copy', () => {
    it('keeps localized text out of the package source', async () => {
        const offenders: string[] = [];
        for (const file of await sourceFiles(SRC)) {
            const lines = (await readFile(file, 'utf8')).split('\n');
            for (const [index, line] of lines.entries()) {
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
                if (/[\u4e00-\u9fff]/.test(line)) offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
