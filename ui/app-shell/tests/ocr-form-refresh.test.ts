// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {OcrSettingsForm, type OcrControls} from '@itookit/ui-common';

it('preserves the input and save feedback for unchanged settings and recovers after a read failure', async () => {
    const state = {value: {connectionId: 'ocr'}, connections: [{id: 'ocr', label: 'OCR'}]};
    const readSettings = vi.fn(async () => state), host = document.createElement('div');
    const form = new OcrSettingsForm(host, {subscribe: () => () => {}, readSettings} as unknown as OcrControls);
    try {
        await form.refresh();
        const select = host.querySelector('select')!;
        host.querySelector('[data-ocr-status]')!.textContent = 'Saved';
        await form.refresh();
        expect(host.querySelector('select')).toBe(select);
        expect(host.querySelector('[data-ocr-status]')!.textContent).toBe('Saved');
        readSettings.mockRejectedValueOnce(new Error('Offline')); await form.refresh();
        expect(host.textContent).toContain('Offline');
        await form.refresh(); expect(host.querySelector('select')?.value).toBe('ocr');
        expect(host.querySelector('[data-ocr-status]')!.textContent).toBe('');
        expect(host.querySelector('[data-ocr-retry]')).toBeNull();
    } finally {form.destroy();}
});
