// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {sha256Hex} from '@itookit/common';
import {ArtifactCommand, type ExecutionArtifactDescriptor, type ReadExecutionArtifact} from '@itookit/app-contracts';
import {TaskArtifactBrowser} from '../../llm-ui-adapter/src/components/dag/TaskArtifactBrowser';
import {readArtifactContent} from '../../llm-ui-adapter/src/components/dag/artifact-content';

const cleanups: Array<() => void> = [];
afterEach(() => {for (const close of cleanups.splice(0).reverse()) close(); vi.unstubAllGlobals(); document.body.innerHTML = '';});
async function fixture(text = '<script>verified material</script>', mimeType = 'text/plain') {
    const data = new TextEncoder().encode(text), digest = await sha256Hex(data);
    const artifact: ExecutionArtifactDescriptor = {reference: {kind: 'task-output', sessionId: 's', taskId: 't', artifactId: 'committed'}, taskId: 't',
        outputName: 'report', name: '<script>report.txt', kind: mimeType.startsWith('image/') ? 'binary' : 'text', mimeType, bytes: data.length, sha256: digest};
    const execute = vi.fn(async (name: string, input: unknown): Promise<unknown> => {
        if (name === ArtifactCommand.List) return {sessionId: 's', taskId: 't', items: [artifact]};
        const request = input as ReadExecutionArtifact, offset = request.offset ?? 0, end = Math.min(data.length, offset + (request.limit ?? data.length));
        return {reference: artifact.reference, offset, totalBytes: data.length, sha256: digest, mimeType,
            data: new Uint8Array(data.subarray(offset, end)).buffer, ...(end < data.length ? {nextOffset: end} : {})};
    });
    const root = document.createElement('div'); document.body.append(root);
    const browser = new TaskArtifactBrowser(root, {execute} as never); cleanups.push(() => browser.dispose());
    const render = () => {root.innerHTML = browser.render({sessionId: 's', taskId: 't'});}; render();
    return {root, browser, render, execute, artifact, data, commands: {execute} as never};
}

it('loads on demand and preserves escaped previews across execution rerenders without repeating reads', async () => {
    const f = await fixture(); expect(f.execute).not.toHaveBeenCalled();
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-artifact-preview]')).not.toBeNull());
    f.root.querySelector<HTMLButtonElement>('[data-artifact-preview]')!.click(); f.render();
    await vi.waitFor(() => expect(f.root.querySelector('pre')?.textContent).toBe('<script>verified material</script>'));
    expect(f.root.querySelector('script')).toBeNull(); expect(f.execute.mock.calls.filter(([name]) => name === ArtifactCommand.Read)).toHaveLength(1);
    f.render(); expect(f.root.querySelector('pre')?.textContent).toBe('<script>verified material</script>');
    expect(f.execute).toHaveBeenCalledTimes(2);
});

it('reassembles and verifies multiple byte pages and refuses an invented continuation response', async () => {
    const f = await fixture('x'.repeat(1024 * 1024 + 7));
    const complete = await readArtifactContent(f.commands, f.artifact, {signal: new AbortController().signal, maxBytes: 2 * 1024 * 1024});
    expect(complete.bytes.byteLength).toBe(f.data.byteLength); expect(await sha256Hex(complete.bytes)).toBe(f.artifact.sha256); expect(complete.truncated).toBe(false); expect(f.execute).toHaveBeenCalledTimes(2);
    const real = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (name, request) => ({...await real(name, request) as object, nextOffset: 1}));
    await expect(readArtifactContent(f.commands, f.artifact, {signal: new AbortController().signal, maxBytes: 2 * 1024 * 1024}))
        .rejects.toMatchObject({code: 'ARTIFACT_RESPONSE_INVALID'});
});

it('rejects corrupt content before exposing a URL and bounds preview versus download memory', async () => {
    const f = await fixture('data'.repeat(100));
    const real = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (name, request) => ({...await real(name, request) as object, data: new Uint8Array(f.data.length).buffer}));
    await expect(readArtifactContent(f.commands, f.artifact, {signal: new AbortController().signal, maxBytes: 1000}))
        .rejects.toMatchObject({code: 'ARTIFACT_BINARY_INTEGRITY'});
    f.execute.mockImplementation(real); f.execute.mockClear();
    await expect(readArtifactContent(f.commands, f.artifact, {signal: new AbortController().signal, maxBytes: 20}))
        .rejects.toMatchObject({code: 'ARTIFACT_DOWNLOAD_TOO_LARGE'});
    expect(f.execute).not.toHaveBeenCalled();
    const preview = await readArtifactContent(f.commands, f.artifact, {signal: new AbortController().signal, maxBytes: 20, previewBytes: 20});
    expect(preview.bytes).toHaveLength(20); expect(preview.truncated).toBe(true);
});

it('ignores a late read after view destruction and revokes owned image previews', async () => {
    const created = vi.fn(() => 'blob:artifact'), revoked = vi.fn();
    vi.stubGlobal('URL', {createObjectURL: created, revokeObjectURL: revoked});
    const f = await fixture('image bytes', 'image/png');
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-artifact-preview]')).not.toBeNull());
    f.root.querySelector<HTMLButtonElement>('[data-artifact-preview]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('img')?.src).toBe('blob:artifact'));
    f.browser.clear(); expect(revoked).toHaveBeenCalledWith('blob:artifact'); f.render();
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-artifact-preview]')).not.toBeNull());
    let release!: (value: unknown) => void; const real = f.execute.getMockImplementation()!;
    f.execute.mockImplementation((name, input) => name === ArtifactCommand.Read ? new Promise(resolve => {release = resolve;}) : real(name, input));
    f.root.querySelector<HTMLButtonElement>('[data-artifact-preview]')!.click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.browser.dispose(); release(await real(ArtifactCommand.Read, {offset: 0}));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(created).toHaveBeenCalledOnce();
});

it('keeps catalog responses in their original execution scope and hides raw failure details', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({sessionId: 'other', taskId: 'elsewhere', items: [f.artifact]});
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.textContent).toContain('ARTIFACT_RESPONSE_INVALID'));
    expect(f.root.querySelector('[data-artifact-preview]')).toBeNull();
    f.execute.mockRejectedValue(Object.assign(new Error('SECRET PRIVATE RESULT'), {code: 'EACCES'}));
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.textContent).toContain('EACCES'));
    expect(f.root.textContent).not.toContain('SECRET PRIVATE RESULT');
});

it('anchors history artifacts to the actual execution and ignores a late catalog after that execution changes', async () => {
    const {SessionRenderer} = await import('../../llm-ui-adapter/src/components/history/SessionRenderer');
    const f = await fixture(); f.browser.dispose(); f.root.replaceChildren();
    const renderer = new SessionRenderer(f.root, {artifacts: {commands: f.commands,
        scope: group => group.execution ? {sessionId: 's', taskId: group.execution.taskId} : undefined}});
    cleanups.push(() => {void renderer.destroy();});
    const group = {id: 'assistant', role: 'assistant', execution: {taskId: 't', role: 'primary'}, timestamp: 0} as const;
    renderer.appendSession(group, false);
    expect(f.root.querySelector('.llm-ui-execution-root > [data-history-artifacts]')).not.toBeNull();
    let release!: (value: unknown) => void;
    f.execute.mockImplementation(() => new Promise(resolve => {release = resolve;}));
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await renderer.reconcileSessions([{...group, execution: {taskId: 'new-task', role: 'primary'}}]);
    release({sessionId: 's', taskId: 't', items: [f.artifact]});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.root.querySelector('[data-artifact-preview]')).toBeNull();
    expect(f.root.querySelector<HTMLElement>('[data-artifact-scope]')?.dataset.artifactScope).toContain('new-task');
    expect(f.execute).toHaveBeenCalledOnce(); await renderer.destroy();
});

it('keeps nested artifact browsers with the same execution scope from handling each other’s events', async () => {
    const f = await fixture(), inner = document.createElement('div'); f.root.append(inner);
    const browser = new TaskArtifactBrowser(inner, f.commands); cleanups.push(() => browser.dispose());
    inner.innerHTML = browser.render({sessionId: 's', taskId: 't'});
    inner.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(inner.querySelector('[data-artifact-preview]')).not.toBeNull());
    expect(f.execute).toHaveBeenCalledOnce();
    const outer = f.root.querySelector<HTMLElement>('[data-artifact-scope]')!;
    expect(outer.querySelector('[data-artifact-preview]')).toBeNull();
    outer.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(outer.querySelector('[data-artifact-preview]')).not.toBeNull());
    expect(f.execute).toHaveBeenCalledTimes(2);
});

it('stops pagination when hidden and allows a fresh catalog after reactivation', async () => {
    const f = await fixture('x'.repeat(1024 * 1024 + 3));
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-artifact-download]')).not.toBeNull());
    const real = f.execute.getMockImplementation()!;
    let release!: (value: unknown) => void, request: unknown;
    f.execute.mockImplementation((name, input) => name === ArtifactCommand.Read ? new Promise(resolve => {request = input; release = resolve;}) : real(name, input));
    f.root.querySelector<HTMLButtonElement>('[data-artifact-download]')!.click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.browser.setVisible(false); release(await real(ArtifactCommand.Read, request));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.execute.mock.calls.filter(([name]) => name === ArtifactCommand.Read)).toHaveLength(1);
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    expect(f.execute).toHaveBeenCalledTimes(2);
    f.browser.setVisible(true); f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-artifact-download]')).not.toBeNull());
    expect(f.execute).toHaveBeenCalledTimes(3);
});

it('rejects malformed catalog metadata before rendering any item', async () => {
    const f = await fixture();
    for (const page of [{sessionId: 's', taskId: 't', items: [{...f.artifact, name: null}]},
        {sessionId: 's', taskId: 't', items: [f.artifact], nextOffset: 100}]) {
        f.execute.mockResolvedValue(page); f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
        await vi.waitFor(() => expect(f.root.querySelector('[data-artifacts-load]')?.hasAttribute('disabled')).toBe(false));
        expect(f.root.textContent).toContain('ARTIFACT_RESPONSE_INVALID');
        expect(f.root.querySelector('[data-artifact-preview]')).toBeNull();
    }
});

it('releases image URLs when the displayed execution scope is replaced', async () => {
    const revoked = vi.fn(); vi.stubGlobal('URL', {createObjectURL: () => 'blob:old-task', revokeObjectURL: revoked});
    const f = await fixture('image', 'image/png');
    f.root.querySelector<HTMLButtonElement>('[data-artifacts-load]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('[data-artifact-preview]')).not.toBeNull());
    f.root.querySelector<HTMLButtonElement>('[data-artifact-preview]')!.click();
    await vi.waitFor(() => expect(f.root.querySelector('img')).not.toBeNull());
    f.root.innerHTML = f.browser.render({sessionId: 's', taskId: 'new-task'}); f.browser.prune();
    expect(revoked).toHaveBeenCalledWith('blob:old-task');
    f.render(); expect(f.root.querySelector('img')).toBeNull(); expect(f.root.querySelector('[data-artifacts-load]')).not.toBeNull();
});
