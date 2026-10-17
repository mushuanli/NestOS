// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoryView } from '../../llm-ui-adapter/src/components/HistoryView';
import type { SessionGroup } from '@itookit/llm-session/contracts';

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
    Object.defineProperties(Range.prototype, {getClientRects: {configurable: true, value: () => []}, getBoundingClientRect: {configurable: true, value: () => new DOMRect()}});
});
afterEach(() => {
    document.body.replaceChildren(); vi.unstubAllGlobals();
    delete (Range.prototype as any).getClientRects; delete (Range.prototype as any).getBoundingClientRect;
});
it.each(['local', 'native', 'refresh'])('replaces a %s submission only by its correlated message, retaining identical earlier text', async kind => {
    const host = document.createElement('div'); document.body.append(host);
    const header = document.createElement('div'), view = new HistoryView(host, {header});
    const earlier: SessionGroup = {id: 'earlier-user', role: 'user', content: 'same prompt', timestamp: 1};
    const actual: SessionGroup = {...earlier, id: 'confirmed-user'};
    try {
        await view.renderSnapshot([earlier]);
        view.setSubmission({id: 'pending', text: 'same prompt', timestamp: 2, state: 'submitting', messageId: actual.id});
        expect(host.querySelectorAll('.llm-ui-session--user')).toHaveLength(2);
        if (kind === 'local') view.processEvent({type: 'message:appended', payload: {sessionGroup: actual}} as never);
        else if (kind === 'refresh') view.renderFull([earlier, actual]);
        else await view.renderSnapshot([earlier, actual]);
        view.setSubmission({id: 'pending', text: 'same prompt', timestamp: 2, state: 'accepted', messageId: actual.id});
        expect(host.querySelectorAll('.llm-ui-session--user')).toHaveLength(2);
        expect(host.querySelector('.llm-ui-submission-status')).toBeNull();
        expect(host.firstElementChild).toBe(header);
    } finally { await view.destroy(); }
});
