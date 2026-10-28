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

it('groups configuration with its connection and reveals dependent options without clearing hidden values', async () => {
    const {updateFlowConnectionRequirements} = await import('../../llm-ui-adapter/src/components/FlowConnectionFields');
    const {ParameterSources} = await import('../../llm-ui-adapter/src/flows/parameter-sources');
    const condition = {kind: 'param' as const, path: ['enabled']};
    const parameters: FlowParameter[] = [
        {name: 'enabled', type: 'boolean', default: false, presentation: {group: 'Generation', contentSource: false}},
        {name: 'count', type: 'number', default: 3, presentation: {group: 'Generation', contentSource: false, visibleWhen: condition}},
    ];
    const connection = {connections: [], onChange() {}, slots: [{name: 'media', requiredWhen: condition, presentation: {group: 'Generation'}}]};
    const root = document.createElement('div'); root.innerHTML = flowParameterFields(parameters, connection); document.body.append(root);
    cleanups.push(bindFlowParameterState(root, parameters, [], values => updateFlowConnectionRequirements(root, connection, values)));
    cleanups.push(new ParameterSources({} as never, {navigation: 'projects'}, parameters).mount(root));
    const group = root.querySelector('.flow-parameter-group')!;
    expect(group.querySelector('[data-parameter-row="0"]')).not.toBeNull(); expect(group.querySelector('[data-slot-row="0"]')).not.toBeNull();
    expect(root.querySelector<HTMLElement>('[data-parameter-row="1"]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-slot-row="0"]')!.hidden).toBe(true);
    expect(root.querySelector('.flow-content-source')).toBeNull();
    const checkbox = root.querySelector<HTMLInputElement>('[data-parameter="0"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    expect(root.querySelector<HTMLElement>('[data-parameter-row="1"]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-slot-row="0"]')!.hidden).toBe(false);
    checkbox.checked = false; checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    expect(readFlowParameterForm(root, parameters)).toEqual({enabled: false, count: 3});
});

it('binds connection enablement and refreshes voice choices without retaining another model voice', async () => {
    const {syncConnectionParameters} = await import('../../llm-ui-adapter/src/components/FlowConnectionParameters');
    const parameters: FlowParameter[] = [
        {name: 'enabled', type: 'boolean', default: false, presentation: {connectionToggle: 'audio'}},
        {name: 'voice', type: 'string', presentation: {connectionVoices: 'audio'}},
    ];
    const connection = {connections: [{id: 'a', name: 'A', providerId: 'p', voices: ['first']}, {id: 'b', name: 'B', providerId: 'p', voices: ['second']}],
        slots: [{name: 'audio', required: false}], bindings: {audio: 'a'}, onChange() {}};
    const root = document.createElement('div'); root.innerHTML = flowParameterFields(parameters, connection);
    syncConnectionParameters(root, parameters, connection, true);
    const slot = root.querySelector<HTMLSelectElement>('[data-slot-connection]')!;
    expect(slot.value).toBe(''); expect(root.querySelector<HTMLElement>('[data-parameter-row="0"]')!.hidden).toBe(true);
    slot.value = 'a'; syncConnectionParameters(root, parameters, connection);
    const voice = root.querySelector<HTMLSelectElement>('[data-parameter="1"]')!; voice.value = 'first';
    expect(readFlowParameterForm(root, parameters, connection)).toEqual({enabled: true, voice: 'first'});
    slot.value = 'b'; syncConnectionParameters(root, parameters, connection);
    expect(root.querySelector<HTMLSelectElement>('[data-parameter="1"]')!.value).toBe('');
    slot.value = ''; syncConnectionParameters(root, parameters, connection);
    expect(readFlowParameterForm(root, parameters, connection)).toEqual({enabled: false});
});

it('separates declared inputs and options from required policies while preserving validation and values', async () => {
    const {ParameterSources} = await import('../../llm-ui-adapter/src/flows/parameter-sources');
    const parameters: FlowParameter[] = [
        {name: 'body', type: 'string', role: 'input', default: 'essay'},
        {name: 'score', type: 'number', role: 'option', default: 9},
        {name: 'parallel', type: 'number', role: 'policy', required: true, default: 4, maximum: 4},
    ];
    const root = document.createElement('div'); root.innerHTML = flowParameterFields(parameters); document.body.append(root);
    cleanups.push(bindFlowParameterState(root, parameters, [], () => {}));
    cleanups.push(new ParameterSources({} as never, {navigation: 'projects'}, parameters).mount(root));
    expect(root.querySelectorAll('.flow-content-source')).toHaveLength(1);
    expect(root.querySelector('[data-parameter="1"]')!.closest('details')).toBeNull();
    const policy = root.querySelector<HTMLInputElement>('[data-parameter="2"]')!;
    expect(policy.closest('details')!.open).toBe(false);
    expect(readFlowParameterForm(root, parameters)).toEqual({body: 'essay', score: 9, parallel: 4});
    policy.value = '5';
    try {readFlowParameterForm(root, parameters); throw new Error('Expected validation');}
    catch (error) {showFlowFieldError(root, error);}
    expect(policy.closest('details')!.open).toBe(true);
    expect(policy.getAttribute('aria-invalid')).toBe('true');
});
