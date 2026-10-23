// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { SessionRenderer } from '../../llm-ui-adapter/src/components/history/SessionRenderer';

afterEach(() => document.body.replaceChildren());

it('anchors concurrent calls after their source round and preserves them when history is rebuilt', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const renderer = new SessionRenderer(host, {});
    const append = (round: string) => renderer.appendSession({id: `round-${round}-assistant`, role: 'assistant', content: ''} as never, false);
    append('one');
    const first = document.createElement('article'), second = document.createElement('article');
    first.dataset.invocation = 'a'; second.dataset.invocation = 'b';
    const remove = renderer.mountInvocation(first, 'one'); renderer.mountInvocation(second, 'one'); append('two');
    const order = () => [...host.children].map(element => (element as HTMLElement).dataset.invocation ?? (element as HTMLElement).dataset.sessionId);
    expect(order()).toEqual(['round-one-assistant', 'a', 'b', 'round-two-assistant']);
    renderer.clear(); renderer.renderWelcome(); append('one'); append('two');
    expect(order()).toEqual(['round-one-assistant', 'a', 'b', 'round-two-assistant']);
    remove(); expect(first.isConnected).toBe(false); expect(second.isConnected).toBe(true);
    await renderer.destroy(); expect(host.childElementCount).toBe(0);
});
