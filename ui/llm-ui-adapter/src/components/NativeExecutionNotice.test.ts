import type {ConversationSnapshot} from '../contracts';
// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {NativeExecutionNotice} from './NativeExecutionNotice';


it('shows compaction prominently and removes it on resumed work or completion', () => {
    const view = new NativeExecutionNotice();
    const state = {observation: {execution: 'running', activity: {turnId: 'turn', phase: 'compacting'}}} as ConversationSnapshot;
    try {
        view.update(state); expect(view.element.hidden).toBe(false); expect(view.element.textContent).toContain('正在整理上下文');
        view.setActive(false); expect(view.element.hidden).toBe(true);
        view.setActive(true); expect(view.element.hidden).toBe(false);
        view.update({...state, observation: {...state.observation!, activity: {turnId: 'turn', phase: 'reasoning'}}});
        expect(view.element.hidden).toBe(true);
        view.update({...state, observation: {...state.observation!, execution: 'idle'}}); expect(view.element.hidden).toBe(true);
    } finally {view.destroy();}
});
