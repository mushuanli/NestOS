import { describe, expect, it } from 'vitest';
import { responseEvents } from '../src/durable/program-helpers';

describe('responseEvents', () => {
    it('emits only round:end — streaming content is emitted by the llm.chat effect', () => {
        const actions = responseEvents({ sessionId: 's', roundId: 'r' }, 2);
        expect(actions).toHaveLength(1);
        const event = actions[0].payload as { type: string; round: number };
        expect(event.type).toBe('round:end');
        expect(event.round).toBe(2);
    });
});
