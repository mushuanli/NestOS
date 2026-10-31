import { escapeHTML, t } from '@itookit/common';

const PREVIEW_LIMIT = 100000;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function renderMCPPreviewText(text: string): string {
    const suffix = text.length > PREVIEW_LIMIT ? `\n${t('mcp.previewTruncated')}` : '';
    return `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(text.slice(0, PREVIEW_LIMIT) + suffix)}</pre>`;
}

function resourceBody(content: RecordValue, fallbackMime: string, operationId: string): string {
    if (typeof content.text !== 'string') return `<p>${t('mcp.binaryResource')}</p>`;
    const text = content.text;
    const mime = (typeof content.mimeType === 'string' ? content.mimeType : fallbackMime).split(';')[0].trim().toLowerCase();
    const declaredJson = mime === 'application/json' || mime.endsWith('+json');
    if (!declaredJson && !/^[\s]*[\[{]/.test(text)) return renderMCPPreviewText(text);
    const started = performance.now();
    try {
        return renderMCPPreviewText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
        if (!declaredJson) return renderMCPPreviewText(text);
        console.warn('mcp.resource.preview.invalid-json', { operation: 'mcp.resource.preview', operationId,
            stage: 'format', result: 'failure', code: 'INVALID_RESOURCE_JSON', durationMs: performance.now() - started });
        return `<p role="status">${t('mcp.invalidResourceJson')}</p>${renderMCPPreviewText(text)}`;
    }
}

export function renderMCPResourcePreview(result: unknown, fallbackMime = '', operationId = ''): string {
    const raw = renderMCPPreviewText(JSON.stringify(result, null, 2) ?? '');
    if (!record(result) || !Array.isArray(result.contents) || !result.contents.length) return raw;
    const contents = result.contents.map(content => {
        if (!record(content) || (typeof content.text !== 'string' && typeof content.blob !== 'string')) {
            return renderMCPPreviewText(JSON.stringify(content, null, 2) ?? '');
        }
        const uri = typeof content.uri === 'string' ? content.uri : '';
        const mime = typeof content.mimeType === 'string' ? content.mimeType : fallbackMime;
        return `<section><strong>${escapeHTML(uri)}</strong><p>${escapeHTML(mime)}</p>${resourceBody(content, fallbackMime, operationId)}</section>`;
    }).join('');
    return `<div style="max-height:60vh;overflow:auto">${contents}<details><summary>${t('mcp.rawResponse')}</summary>${raw}</details></div>`;
}
