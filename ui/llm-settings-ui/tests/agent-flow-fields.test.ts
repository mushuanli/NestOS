// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderAgentFlowFields, readAgentFlowFields } from '../src/editors/agent-flow-fields';
import type { FormParameter } from '@itookit/llm-ui/forms';

function form(parameters: FormParameter[], values: Record<string, unknown> = {}) {
    const root = document.createElement('div');
    root.innerHTML = renderAgentFlowFields({ parameters }, { parameters: values }, []);
    const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="agentFlowParameter:${name}"]`)!;
    return { root, field, read: () => readAgentFlowFields(root) };
}

it('renders schema controls and preserves explicit false, zero and unknown saved parameters', () => {
    const f = form([
        { name: 'title', type: 'string', widget: 'text', label: 'Title', description: 'Shown to readers' },
        { name: 'body', type: 'string', widget: 'textarea' },
        { name: 'enabled', type: 'boolean' },
        { name: 'count', type: 'number', integer: true, minimum: 0, maximum: 10 },
        { name: 'level', type: 'string', options: ['first', 'second'] },
        { name: 'settings', type: 'json' },
    ], { enabled: false, count: 0, level: 'second', settings: { nested: [1] }, hidden: { keep: true } });
    expect(f.field('title').tagName).toBe('INPUT');
    expect(f.field('body').tagName).toBe('TEXTAREA');
    expect(f.field('enabled').tagName).toBe('SELECT');
    expect(f.field('settings').tagName).toBe('TEXTAREA');
    expect(f.read().parameters).toEqual({ enabled: false, count: 0, level: 'second', settings: { nested: [1] }, hidden: { keep: true } });
    expect(f.root.textContent).toContain('Shown to readers');
});

it('leaves required defaults optional and clearing an override restores inheritance', () => {
    const f = form([{ name: 'count', type: 'number', required: true, default: 3 }, { name: 'enabled', type: 'boolean', required: true }], { count: 8, hidden: 2 });
    expect(f.root.querySelector('[required]')).toBeNull();
    f.field('count').value = '';
    expect(f.read().parameters).toEqual({ hidden: 2 });
    expect(f.root.textContent).toContain('3');
});

it('keeps unavailable connection bindings and hidden slots while allowing explicit inheritance', () => {
    const root = document.createElement('div');
    root.innerHTML = renderAgentFlowFields({ connections: [
        { name: 'vision', connectionId: 'current', description: 'Image input', required: true },
        { name: 'extra', required: false },
    ] }, { connectionBindings: { vision: 'removed', hidden: 'legacy' } }, [{ id: 'current', name: 'Current model' }]);
    const select = root.querySelector<HTMLSelectElement>('[name="agentFlowConnection:vision"]')!;
    expect(select.textContent).toContain('removed');
    expect(root.textContent).toContain('Current model');
    expect(root.textContent).toContain('Image input');
    expect(readAgentFlowFields(root).connectionBindings).toEqual({ vision: 'removed', hidden: 'legacy' });
    select.value = '';
    expect(readAgentFlowFields(root).connectionBindings).toEqual({ hidden: 'legacy' });
    select.value = JSON.stringify('current');
    expect(readAgentFlowFields(root).connectionBindings).toEqual({ vision: 'current', hidden: 'legacy' });
});

it('reports the specific field on invalid JSON and numeric constraints without discarding input', () => {
    const f = form([{ name: 'settings', type: 'json', label: 'Settings' }, { name: 'count', type: 'number', minimum: 0, integer: true }]);
    f.field('settings').value = '{';
    expect(f.read).toThrow('Settings'); expect(f.field('settings').value).toBe('{');
    f.field('settings').value = '{}'; f.field('count').value = '-1'; expect(f.read).toThrow('count');
    expect(f.read).toThrow('0');
    f.field('count').value = '1.5'; expect(f.read).toThrow('count');
});

it('escapes arbitrary schema text, values and metadata', () => {
    const injected = '<img src=x onerror=alert(1)>';
    const f = form([{ name: 'title', type: 'string', label: injected, description: injected }], { title: '"><svg/onload=alert(1)>', hidden: injected });
    expect(f.root.querySelector('img,svg')).toBeNull();
    expect(f.read().parameters).toEqual({ title: '"><svg/onload=alert(1)>', hidden: injected });
});
