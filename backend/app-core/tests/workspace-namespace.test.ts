import { expect, it } from 'vitest';
import { projectRelativePath, WORKSPACE_PATH, workspacePath } from '../src/vfs/workspace-namespace';

it('enters the workspace namespace from source-root-relative paths', () => {
    expect(WORKSPACE_PATH).toBe('/workspace');
    expect(workspacePath('/')).toBe('/workspace');
    expect(workspacePath('/docs/note.md')).toBe('/workspace/docs/note.md');
    // Inputs are source-root-relative but must be rooted; callers join their cwd first.
    expect(() => workspacePath('docs')).toThrowError(/absolute virtual path/);
});

it('strips only the project root so sibling grants stay outside project files', () => {
    expect(projectRelativePath('/workspace')).toBe('/');
    expect(projectRelativePath('/workspace/docs/note.md')).toBe('/docs/note.md');
    for (const path of ['/etc/passwd', '/workspace-other/note.md', '/reference/secret.md']) {
        expect(() => projectRelativePath(path)).toThrowError(/outside the project workspace/);
    }
});

it('uses the manifest root instead of a stale project prefix for Session ownership', async () => {
    const { browserTargetFolder, resolveBrowserTarget } = await import('../src/session/browser-routes');
    const path = '/folder:Old/session-a';
    expect(browserTargetFolder(resolveBrowserTarget(path), path, null)).toBe('/');
    expect(browserTargetFolder(resolveBrowserTarget(path), path, '/New')).toBe('/New');
    expect(browserTargetFolder(resolveBrowserTarget(path), path)).toBe('/Old');
});
