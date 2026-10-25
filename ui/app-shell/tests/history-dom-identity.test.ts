// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {SessionRenderer} from '../../llm-ui-adapter/src/components/history/SessionRenderer';

const renderers: SessionRenderer[] = [];
afterEach(async () => {for (const renderer of renderers.splice(0)) await renderer.destroy(); document.body.replaceChildren();});
function setup(readOnly = false) {
    const host = document.createElement('div'); document.body.append(host);
    const renderer = new SessionRenderer(host, {readOnly}); renderers.push(renderer);
    const append = (id: string) => renderer.appendSession({id, role: 'assistant', content: '',
        executionRoot: undefined} as never, false);
    return {host, renderer, append};
}

it('resolves the renderer-owned message when nested content contains the same presentation identity', () => {
    const f = setup(); f.append('message');
    const owned = f.host.firstElementChild;
    const nested = document.createElement('div'); nested.dataset.sessionId = 'message'; f.host.prepend(nested);
    expect(f.renderer.getSessionElement('message')).toBe(owned);
});

it('resolves the replacement while the previous message is still animating out', () => {
    const f = setup(); f.append('message');
    const previous = f.host.firstElementChild;
    f.renderer.removeMessages(['message'], true);
    expect(f.renderer.getSessionElement('message')).toBeNull();
    f.append('message');
    expect(f.renderer.getSessionElement('message')).toBe(f.host.lastElementChild);
    expect(f.renderer.getSessionElement('message')).not.toBe(previous);
});

it('preserves read-only history aliases and clears every owned reference with the view', () => {
    const f = setup(true);
    f.renderer.appendSession({id: 'message', role: 'assistant', content: '',
        executionRoot: {id: 'native-history', executorType: 'agent', data: {}}} as never, false);
    expect(f.renderer.getSessionElement('native-history')).toBe(f.host.firstElementChild);
    f.renderer.clear();
    expect(f.renderer.getSessionElement('message')).toBeNull(); expect(f.renderer.getSessionElement('native-history')).toBeNull();
    f.append('next'); expect(f.renderer.isRendered('message')).toBe(false); expect(f.renderer.isRendered('next')).toBe(true);
});
