// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderProviderApiReference } from '../src/editors/provider-api-reference';
import type { ProviderApiReference } from '@itookit/kernel-adapters/contracts';
import { t } from '@itookit/common';

it('renders reference metadata read-only, distinguishes support and escapes text and unsafe links', () => {
    const reference: ProviderApiReference = {version: 1, reviewedAt: '2026-10-22', scope: 'HTTP only',
        sources: [{id: 'safe', title: 'API docs', url: 'https://example.test/docs'}, {id: 'unsafe', title: 'Unsafe', url: 'javascript:alert(1)'}],
        models: [{id: 'resource', name: 'Resource', kind: 'resource', support: 'implemented'},
            {id: 'variant', name: 'Variant', kind: 'body-model', support: 'unsupported'}], formats: [],
        parameters: [{path: 'instructions', name: 'Instructions', type: 'string', required: false, support: 'partial', notes: '<img src=x onerror=alert(1)>'}],
        voices: [{id: 'voice', name: 'Voice', languages: ['zh']}], discovery: {models: 'Static snapshot', voices: 'Separate API'},
        response: {audioCode: 0, completionCode: 20000000, emptyCompletionData: true}, notes: ['No account authorization implied']};
    const root = document.createElement('div'); root.innerHTML = renderProviderApiReference(reference);
    expect(root.textContent).toContain(t('provider.reference.implemented'));
    expect(root.textContent).toContain(t('provider.reference.unsupported')); expect(root.textContent).toContain(t('provider.reference.partial'));
    expect(root.querySelector('input,select,textarea,img')).toBeNull();
    expect(root.querySelectorAll('a')).toHaveLength(1); expect(root.querySelector('a')!.getAttribute('rel')).toContain('noopener');
    expect(renderProviderApiReference()).toBe('');
});
