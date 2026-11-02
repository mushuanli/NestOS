// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderMCPResourcePreview } from '@itookit/llm-ui-adapter/settings';
import { bindMCPContent } from '@itookit/llm-ui-adapter/settings';

afterEach(() => vi.restoreAllMocks());

function preview(contents: unknown[], mime?: string): HTMLDivElement {
    const root = document.createElement('div');
    root.innerHTML = renderMCPResourcePreview({ contents }, mime, 'test-operation');
    return root;
}

it('formats JSON inside resource text without serializing the envelope into the main preview', () => {
    const value = { name: '中文', nested: { items: [1, 2] }, path: 'C:\\notes' };
    const contents = [{ uri: 'test://json', mimeType: 'application/json', text: JSON.stringify(value) }];
    const root = preview(contents);
    expect(root.querySelector('section pre')?.textContent).toBe(JSON.stringify(value, null, 2));
    expect(root.querySelector('details')?.open).toBe(false);
    expect(root.querySelector('details pre')?.textContent).toBe(JSON.stringify({ contents }, null, 2));
});

it('handles vendor JSON, discovery MIME fallback and JSON objects without MIME metadata', () => {
    for (const mimeType of ['application/example+json; charset=utf-8', undefined]) {
        const root = preview([{ text: '{"a":1}', mimeType }]);
        expect(root.querySelector('section pre')?.textContent).toBe('{\n  "a": 1\n}');
    }
    expect(preview([{ text: '42' }], 'application/json').querySelector('section pre')?.textContent).toBe('42');
});

it('preserves plain text newlines and escapes untrusted body, URI and MIME', () => {
    const text = '<img src=x onerror=alert(1)>\nsecond line\\n';
    const root = preview([{ uri: '<script>bad()</script>', mimeType: '<img src=x>', text }, { text: 'another' }]);
    expect(root.querySelectorAll('section')).toHaveLength(2);
    expect(root.querySelector('section pre')?.textContent).toBe(text);
    expect(root.querySelector('script, img')).toBeNull();
});

it('retains invalid JSON and logs only safe failure metadata', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = '{"secret":"sensitive-value",}';
    const root = preview([{ text, mimeType: 'application/json' }]);
    expect(root.querySelector('section pre')?.textContent).toBe(text);
    expect(root.querySelector('[role=status]')).not.toBeNull();
    expect(log).toHaveBeenCalledWith('mcp.resource.preview.invalid-json', expect.objectContaining({
        operationId: 'test-operation', code: 'INVALID_RESOURCE_JSON', stage: 'format',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-value');
});

it('keeps binary data in the raw view and bounds long text previews', () => {
    const root = preview([{ blob: 'YWJj', mimeType: 'image/png' }, { text: 'a'.repeat(100001) }]);
    expect(root.querySelector('section')?.textContent).not.toContain('YWJj');
    expect(root.querySelectorAll('section')[1].querySelector('pre')!.textContent!.length).toBeLessThan(100100);
    expect(preview([]).querySelector('pre')?.textContent).toContain('"contents": []');
});

it('restores the read button after failure without logging resource contents or exception text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = document.createElement('div');
    root.innerHTML = '<button data-action="preview-resource" data-index="0"></button>';
    const service = { readMCPResource: vi.fn().mockRejectedValue(new Error('private error detail')) };
    bindMCPContent(root, { id: 'server', resources: [{ uri: 'test://private' }] } as never, service as never);
    root.querySelector('button')!.click();
    await vi.waitFor(() => expect(root.querySelector('button')!.disabled).toBe(false));
    expect(log).toHaveBeenCalledWith('mcp.resource.preview.failed', expect.objectContaining({ stage: 'read', code: 'RESOURCE_READ_FAILED' }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private/);
});
