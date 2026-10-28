// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import type {FlowInputGroup, FlowParameter} from '@itookit/llm-flow/contracts';
import {flowParameterFields, readFlowParameterForm} from '../../llm-ui-adapter/src/components/FlowParameterForm';
import {bindFlowParameterState, showFlowFieldError} from '../../llm-ui-adapter/src/components/FlowParameterState';
const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).forEach(stop => stop()); document.body.replaceChildren();});
function mount(parameters: FlowParameter[], mode: FlowInputGroup['mode'] = 'anyOf') {
    const groups = [{name: 'source', mode, parameters: ['text', 'structured']}];
    const root = document.createElement('div'); root.innerHTML = flowParameterFields(parameters, undefined, groups); document.body.append(root);
    cleanups.push(bindFlowParameterState(root, parameters, groups, () => {}));
    return root;
}
it('selects the filled source tab, preserves both values on switching, and collapses only optional settings', () => {
    const parameters: FlowParameter[] = [{name: 'count', type: 'number', default: 2}, {name: 'text', type: 'string'}, {name: 'structured', type: 'json', default: ['word']}];
    const root = mount(parameters), tabs = root.querySelectorAll<HTMLButtonElement>('[data-flow-tab]');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].querySelector<HTMLElement>('[data-flow-filled]')!.hidden).toBe(false);
    expect(root.querySelector('details [data-parameter="0"]')).not.toBeNull();
    tabs[0].click();
    const text = root.querySelector<HTMLTextAreaElement>('[data-parameter="1"]')!; text.value = 'hello'; text.dispatchEvent(new Event('input', {bubbles: true}));
    expect(readFlowParameterForm(root, parameters)).toEqual({count: 2, text: 'hello', structured: ['word']});
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
});
it('reveals an invalid hidden source instead of leaving its error behind another tab', () => {
    const parameters: FlowParameter[] = [{name: 'text', type: 'string', default: 'hello'}, {name: 'structured', type: 'json'}];
    const root = mount(parameters);
    root.querySelector<HTMLTextAreaElement>('[data-parameter="1"]')!.value = '{';
    try {readFlowParameterForm(root, parameters); throw new Error('Expected invalid JSON');}
    catch (error) {showFlowFieldError(root, error);}
    expect(root.querySelector('[data-flow-tab="structured"]')!.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector<HTMLElement>('[data-parameter-row="1"]')!.hidden).toBe(false);
    expect(root.querySelector('[aria-invalid="true"]')).not.toBeNull();
});
it('keeps oneOf exclusive and preselects its single populated member', () => {
    const parameters: FlowParameter[] = [{name: 'text', type: 'string', default: 'hello'}, {name: 'structured', type: 'json'}];
    const root = mount(parameters, 'oneOf');
    expect(root.querySelector<HTMLInputElement>('[data-flow-source="text"]')!.checked).toBe(true);
    expect(root.querySelector('[data-flow-tab]')).toBeNull();
    expect(readFlowParameterForm(root, parameters)).toEqual({text: 'hello'});
});
