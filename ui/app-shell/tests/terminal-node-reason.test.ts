// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { NodeRenderer } from '../../llm-ui/src/components/history/NodeRenderer';

it.each(['failed', 'aborted'])('renders the persisted %s reason as text', status => {
    const error = '<img src=x onerror=alert(1)> permission revoked';
    const { element } = NodeRenderer.create({ id: 'restored', executorType: 'agent', status,
        startTime: 1, data: { error, output: '', thought: '' } } as never);
    expect(element.querySelector('.llm-ui-node__error-embed')?.textContent).toContain(error);
    expect(element.querySelector('img')).toBeNull();
});
