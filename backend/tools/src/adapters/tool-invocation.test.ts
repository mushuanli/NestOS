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

it.each(['RESOURCE_WRITE_DENIED', 'ACCOUNT_SCOPE_REQUIRED'])('preserves a tool failure category without making unknown effects recoverable: %s', async code => {
  const {driver} = fixture({call: async () => {throw Object.assign(new Error('Tool failed'), {code});}});
  expect(await driver.invoke({toolId: 'fixture', args: {value: 'x'}})).toMatchObject({success: false, errorCode: code, recoverable: false});
});

it.each(['Bearer PRIVATE_TOKEN', 'https://private.invalid/token', 'x'.repeat(81), 403])('does not promote arbitrary failure codes to diagnostic metadata: %s', async code => {
  const {driver} = fixture({call: async () => {throw Object.assign(new Error('Tool failed'), {code});}});
  const result = await driver.invoke({toolId: 'fixture', args: {value: 'x'}});
  expect(result.success).toBe(false); expect(result.errorCode).toBeUndefined(); expect(result.recoverable).not.toBe(true);
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

it('uses live enablement in metadata, definitions and execution when an existing tool is toggled', async () => {
  let enabled = false;
  const {driver, call} = fixture({isEnabled: () => enabled});
  expect(driver.getToolMeta('fixture')?.enabled).toBe(false); expect(driver.getToolDefinitions()).toEqual([]);
  enabled = true;
  expect(driver.getToolMeta('fixture')?.enabled).toBe(true); expect(driver.getToolDefinitions()).toHaveLength(1);
  expect(await driver.invoke({toolId: 'fixture', args: {value: 'enabled'}})).toMatchObject({success: true});
  enabled = false;
  expect(driver.listTools()[0].enabled).toBe(false);
  expect(await driver.invoke({toolId: 'fixture', args: {value: 'disabled'}})).toMatchObject({errorCode: 'TOOL_DISABLED'});
  expect(call).toHaveBeenCalledTimes(1);
});

it('freezes ordinary defaults per execution identity across retries and reconciliation while explicit arguments take precedence', async () => {
  let defaults = {value: 'original'};
  const reconcile = vi.fn(async args => ({status: 'completed' as const, data: args}));
  const {driver} = fixture({inputDefaults: () => defaults, reconcile});
  const records = new Map<string, unknown>();
  driver.setAssetStore({getRecord: async (key, identity) => records.get(identity.operationId + key),
    putRecord: async (key, value, identity) => {expect(key).toMatch(/^[a-zA-Z0-9._:/-]{1,256}$/); records.set(identity.operationId + key, structuredClone(value));}} as never);
  const executionIdentity = {operationId: 'operation', sessionId: 's', taskId: 't', effectId: 'e'};
  expect(await driver.invoke({toolId: 'fixture', args: {}, executionIdentity})).toMatchObject({data: {value: 'original'}});
  defaults = {value: 'changed'};
  expect(await driver.invoke({toolId: 'fixture', args: {}, executionIdentity})).toMatchObject({data: {value: 'original'}});
  expect(await driver.reconcile({toolId: 'fixture', args: {}, ...executionIdentity})).toMatchObject({status: 'completed', result: {data: {value: 'original'}}});
  expect(await driver.invoke({toolId: 'fixture', args: {value: 'explicit'}, executionIdentity})).toMatchObject({data: {value: 'explicit'}});
  expect(await driver.invoke({toolId: 'fixture', args: {}, executionIdentity: {...executionIdentity, operationId: 'new'}})).toMatchObject({data: {value: 'changed'}});
});

it('does not adopt current defaults when reconciling an old operation with no saved defaults', async () => {
  const {driver} = fixture({inputDefaults: () => ({value: 'new-account'}), reconcile: async args => ({status: 'completed', data: args})});
  driver.setAssetStore({getRecord: async () => undefined, putRecord: vi.fn()} as never);
  await expect(driver.reconcile({toolId: 'fixture', args: {}, operationId: 'old', sessionId: 's', taskId: 't', effectId: 'e'})).rejects.toMatchObject({code: 'INVALID_ARGUMENTS'});
});
