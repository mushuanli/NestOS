import { expect, it } from 'vitest';
import { DurableAgentProgram } from './agent-program';

const schema = { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: {
    type: 'object', required: ['label', 'level'], additionalProperties: false, properties: { label: { type: 'string' }, level: { type: 'string', enum: ['1', '2'] } },
} } } };
function start(localSchema: Record<string, unknown> | boolean = schema) {
    const program = new DurableAgentProgram();
    const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', maxExchanges: 3,
        messages: [{ role: 'user', content: 'Return items' }], responseFormat: { type: 'json_object' },
        outputValidation: { onInvalid: 'repair', retries: 1, schema: localSchema } });
    return { program, step: program.reduce(initial.state, { type: 'signal', sequence: 1, signal: { type: 'capabilities', payload: { llmHandleId: 'llm' } } }) };
}
const response = (content: string, exchange = 1) => ({ type: 'effect-completed' as const, effectId: `llm-exchange-${exchange}`,
    result: { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] } });

it.each([true, false])('repairs json_object missing fields locally and resumes its bounded checkpoint (valid=%s)', valid => {
    const { program, step } = start();
    const request = step.actions?.find(action => action.type === 'effect');
    expect(request).toMatchObject({ effect: { request: { request: { responseFormat: { type: 'json_object' } } } } });
    if (request?.type === 'effect') expect((request.effect.request as any).request).not.toHaveProperty('outputValidation');
    const broken = JSON.stringify({ items: [{ label: 'one' }] });
    const repair = program.reduce(step.state, response(broken));
    expect(repair.state.outputValidationAttempts).toBe(1);
    expect(repair.state.messages.at(-1)?.content).toContain('$.items[0].level is required');
    expect(repair.state.messages.at(-1)?.content).toContain(JSON.stringify(schema));
    const checkpoint = JSON.parse(JSON.stringify(repair.state));
    expect(checkpoint.input.outputValidation.schema).toEqual(schema);
    const content = valid ? JSON.stringify({ items: [{ label: 'one', level: '2' }] }) : broken;
    const resumed = new DurableAgentProgram().reduce(checkpoint, response(content, 2));
    expect(resumed.state.exchanges).toBe(2);
    if (valid) expect(resumed.next).toMatchObject({ type: 'complete', output: { outputs: { result: { type: 'json', content: JSON.parse(content) } } } });
    else expect(resumed.next).toMatchObject({ type: 'fail', error: { code: 'INVALID_OUTPUT', message: expect.stringContaining('(1/1)') } });
});

it.each(['malformed-json', 'unknown-property'])('records safe %s diagnostics without model body, arbitrary keys, or schema values', kind => {
    const secret = 'private-output-token';
    const { program, step } = start({ type: 'object', properties: { choice: { enum: ['private-schema-value'] } }, additionalProperties: false });
    const content = kind === 'malformed-json' ? `{"choice":"${secret}` : JSON.stringify({ [secret]: secret });
    const repair = program.reduce(step.state, response(content));
    const diagnostic = repair.actions?.find(action => action.type === 'emit' && action.eventType === 'llm.output.invalid');
    expect(diagnostic).toMatchObject({ payload: { contentLength: content.length, category: kind === 'malformed-json' ? 'invalid-json' : 'output-contract' } });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(JSON.stringify(diagnostic)).not.toContain('private-schema-value');
    expect(JSON.stringify(diagnostic)).not.toContain('contentHead');
    expect(JSON.stringify(diagnostic)).not.toContain('contentTail');
    const exhausted = program.reduce(JSON.parse(JSON.stringify(repair.state)), response(content, 2));
    expect(JSON.stringify(exhausted.next)).not.toContain(secret);
});

it.each([
    { constraints: { minLength: 1 }, invalid: '', valid: 'value', category: 'minLength' },
    { constraints: { pattern: '\\S' }, invalid: ' \n\t', valid: 'value', category: 'pattern' },
    { constraints: { minLength: 2 }, invalid: '🌿', valid: '🌿A', category: 'minLength' },
    { constraints: { maxLength: 1 }, invalid: 'AB', valid: '🌿', category: 'maxLength' },
])('repairs string $category violations and validates Unicode code point lengths', ({ constraints, invalid, valid, category }) => {
    const { program, step } = start({ type: 'object', properties: { label: { type: 'string', ...constraints } }, required: ['label'] });
    const repair = program.reduce(step.state, response(JSON.stringify({ label: invalid })));
    expect(repair.state.outputValidationAttempts).toBe(1);
    expect(repair.state.messages.at(-1)?.content).toContain(category);
    const resumed = new DurableAgentProgram().reduce(JSON.parse(JSON.stringify(repair.state)), response(JSON.stringify({ label: valid }), 2));
    expect(resumed.next).toMatchObject({ type: 'complete', output: { outputs: { result: { content: { label: valid } } } } });
    const exhausted = program.reduce(JSON.parse(JSON.stringify(repair.state)), response(JSON.stringify({ label: invalid }), 2));
    expect(exhausted.next).toMatchObject({ type: 'fail', error: { code: 'INVALID_OUTPUT' } });
});

it('reports invalid schema patterns without throwing or exposing output values', () => {
    const { program, step } = start({ type: 'object', properties: { label: { type: 'string', pattern: '[' } } });
    const repair = program.reduce(step.state, response(JSON.stringify({ label: 'private-output-value' })));
    expect(repair.state.messages.at(-1)?.content).toContain('invalid schema pattern');
    const diagnostic = repair.actions?.find(action => action.type === 'emit' && action.eventType === 'llm.output.invalid');
    expect(JSON.stringify(diagnostic)).not.toContain('private-output-value');
});
