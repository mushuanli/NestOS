import { expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { buildTool, type Tool } from '../core/Tool';
import { ToolDeviceDriver } from './tool-device-driver';

function fixture(overrides: Partial<Tool> = {}) {
  const call = vi.fn(async (args: Record<string, unknown>) => ({ data: args }));
  const tool = buildTool({ name: 'fixture', maxResultSizeChars: 100,
    inputSchema: z.strictObject({ value: z.string().min(1) }),
    description: async () => '', prompt: async () => '', call,
    mapToolResultToToolResultBlockParam: (data, tool_use_id) => ({ type: 'tool_result', tool_use_id, content: JSON.stringify(data) }),
    ...overrides });
  return { call, tool, driver: new ToolDeviceDriver([tool]) };
}

it.each([{ value: 1 }, { value: 'x', unknown: true }])('rejects invalid input before calling the tool: %j', async args => {
  const { call, driver } = fixture();
  expect(await driver.invoke({ toolId: 'fixture', args })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS', recoverable: true });
  expect(call).not.toHaveBeenCalled();
});

it('runs semantic validation before permissions', async () => {
  const checkPermissions = vi.fn();
  const { call, driver } = fixture({ validateInput: async () => ({ result: false, message: 'bad value', errorCode: 1 }), checkPermissions });
  expect(await driver.invoke({ toolId: 'fixture', args: { value: 'x' } })).toMatchObject({ error: 'bad value', recoverable: true });
  expect(checkPermissions).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
});

it('enforces permission denial at execution', async () => {
  const { call, driver } = fixture({ checkPermissions: async () => ({ behavior: 'deny', reason: 'read only' }) });
  expect(await driver.invoke({ toolId: 'fixture', args: { value: 'x' } })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
  expect(call).not.toHaveBeenCalled();
});

it.each(['normalized', ''])('validates permission-normalized arguments (%j)', async value => {
  const { call, driver } = fixture({ checkPermissions: async () => ({ behavior: 'allow', updatedInput: { value } }) });
  const result = await driver.invoke({ toolId: 'fixture', args: { value: 'original' } });
  expect(result.success).toBe(Boolean(value));
  if (value) expect(call.mock.calls[0][0]).toEqual({ value });
  else expect(call).not.toHaveBeenCalled();
});

it('rejects disabled tools even when their names are known', async () => {
  const { call, driver } = fixture({ isEnabled: () => false });
  expect(await driver.invoke({ toolId: 'fixture', args: { value: 'x' } })).toMatchObject({ errorCode: 'TOOL_DISABLED' });
  expect(call).not.toHaveBeenCalled();
});

it('rechecks enablement after asynchronous permission evaluation', async () => {
  let enabled = true;
  const { call, driver } = fixture({ isEnabled: () => enabled,
    checkPermissions: async () => { enabled = false; return { behavior: 'allow' }; } });
  expect(await driver.invoke({ toolId: 'fixture', args: { value: 'x' } })).toMatchObject({ errorCode: 'TOOL_DISABLED' });
  expect(call).not.toHaveBeenCalled();
});

it('does not execute a pre-aborted request', async () => {
  const { call, driver } = fixture();
  const controller = new AbortController(); controller.abort();
  expect(await driver.invoke({ toolId: 'fixture', args: { value: 'x' }, signal: controller.signal }))
    .toMatchObject({ success: false, errorCode: 'CANCELLED', recoverable: false });
  expect(call).not.toHaveBeenCalled();
});

it('cleans up the abort listener after invocation', async () => {
  const { driver } = fixture();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  await driver.invoke({ toolId: 'fixture', args: { value: 'x' }, signal: controller.signal });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('preserves structured output and bounds oversized output', async () => {
  const { driver } = fixture();
  expect(await driver.invoke({ toolId: 'fixture', args: { value: 'x' } })).toMatchObject({ success: true, data: { value: 'x' } });
  const result = await driver.invoke({ toolId: 'fixture', args: { value: 'x'.repeat(500) } });
  expect(result).toMatchObject({ success: true, truncated: true });
  expect(result.output.length).toBeLessThanOrEqual(100);
  expect(result.output).toContain('[output truncated]');
  expect(result.data).toBeUndefined();
});

it('does not mark unexpected failures as recoverable', async () => {
  const { driver } = fixture({ call: async () => { throw new Error('storage broken'); } });
  const result = await driver.invoke({ toolId: 'fixture', args: { value: 'x' } });
  expect(result).toMatchObject({ success: false, error: 'storage broken' });
  expect(result.recoverable).not.toBe(true);
});

it('validates registered handlers against their JSON Schema', async () => {
  const { driver } = fixture();
  const handler = vi.fn(async () => 'ok');
  driver.registerTool({ id: 'legacy', name: 'legacy', description: '', enabled: true, sideEffect: 'none', timeoutMs: 1000, type: 'plugin' },
    { name: 'legacy', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }, handler);
  expect(await driver.invoke({ toolId: 'legacy', args: { value: 'bad' } })).toMatchObject({ errorCode: 'INVALID_ARGUMENTS' });
  expect(handler).not.toHaveBeenCalled();
  expect(await driver.invoke({ toolId: 'legacy', args: { value: 42 } })).toMatchObject({ success: true, output: 'ok' });
});
