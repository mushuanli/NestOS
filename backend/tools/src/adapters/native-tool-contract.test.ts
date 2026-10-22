import { expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { buildTool } from '../core/Tool';
import { ToolDeviceDriver } from './tool-device-driver';
function fixture() {
    const call = vi.fn(async (_args, context) => ({ data: { id: context.operationId } }));
    const tool = buildTool({ name: 'fixture', version: '2', inputSchema: z.object({}), outputSchema: z.object({ id: z.string() }), maxResultSizeChars: 100,
        description: async () => 'Fixture', prompt: async () => '', validateInput: async () => ({ result: true }), call, reconcile: async (_args, context) => ({ status: 'completed' as const, data: { id: context.operationId } }),
        mapToolResultToToolResultBlockParam: (data, tool_use_id) => ({ type: 'tool_result', tool_use_id, content: JSON.stringify(data) }) });
    return { call, tool, service: new ToolDeviceDriver([tool]) };
}
const identity = { sessionId: 's', taskId: 't', effectId: 'e', operationId: '[s,t,e]' };
it('requires the fixed version and passes a stable identity to execution and reconciliation', async () => {
    const f = fixture();
    const reconcile = vi.spyOn(f.tool, 'reconcile');
    expect(await f.service.invoke({ toolId: 'fixture', toolVersion: '1', args: {}, resultMode: 'structured' })).toMatchObject({ success: false, errorCode: 'TOOL_VERSION_MISMATCH' });
    expect(f.call).not.toHaveBeenCalled();
    expect(await f.service.invoke({ toolId: 'fixture', toolVersion: '2', args: {}, executionIdentity: identity, resultMode: 'structured' })).toMatchObject({ success: true, data: { id: identity.operationId } });
    expect(await f.service.reconcile({ toolId: 'fixture', toolVersion: '2', args: {}, ...identity, resultMode: 'structured' })).toMatchObject({ status: 'completed', result: { data: { id: identity.operationId } } });
    expect(reconcile.mock.calls[0][1].executionIdentity).toEqual(identity);
});
it('validates output schema and rejects oversized structured results instead of truncating', async () => {
    const f = fixture(); f.call.mockResolvedValueOnce({ data: { id: 12 } } as never);
    expect(await f.service.invoke({ toolId: 'fixture', args: {}, resultMode: 'structured' })).toMatchObject({ success: false, errorCode: 'INVALID_OUTPUT', recoverable: false });
    f.call.mockResolvedValueOnce({ data: { id: 'a'.repeat(500) } });
    expect(await f.service.invoke({ toolId: 'fixture', args: {}, resultMode: 'structured' })).toMatchObject({ success: false, errorCode: 'OUTPUT_TOO_LARGE', recoverable: false });
});

it('preserves declared large structured results through invocation and reconciliation while bounding model output', async () => {
    const f = fixture(), data = { id: 'a'.repeat(150_000) };
    f.tool.maxResultSizeChars = 200_000;
    f.call.mockResolvedValue({ data });
    vi.spyOn(f.tool, 'reconcile').mockResolvedValue({ status: 'completed', data });
    const request = { toolId: 'fixture', toolVersion: '2', args: {}, resultMode: 'structured' as const };
    const result = await f.service.invoke({ ...request, executionIdentity: identity });
    expect(result.success).toBe(true);
    expect(result.output === JSON.stringify(data)).toBe(true);
    expect(JSON.stringify(result.data) === JSON.stringify(data)).toBe(true);
    expect(result.truncated).toBeUndefined();
    const reconciled = await f.service.reconcile({ ...request, ...identity });
    expect(reconciled).toMatchObject({ status: 'completed', result: { success: true } });
    expect(reconciled.status === 'completed' && JSON.stringify(reconciled.result.data) === JSON.stringify(data)).toBe(true);
    const modelResult = await f.service.invoke({ toolId: 'fixture', args: {} });
    expect(modelResult).toMatchObject({ success: true, truncated: true });
    expect(modelResult.output.length).toBeLessThanOrEqual(100_000);
    expect(modelResult.data).toBeUndefined();
});

it('rejects structured results above the platform ceiling with size diagnostics and no partial data', async () => {
    const f = fixture();
    f.tool.maxResultSizeChars = Infinity;
    f.call.mockResolvedValueOnce({ data: { id: 'secret'.repeat(2_800_000) } });
    const result = await f.service.invoke({ toolId: 'fixture', args: {}, resultMode: 'structured' });
    expect(result).toMatchObject({ success: false, errorCode: 'OUTPUT_TOO_LARGE', recoverable: false });
    expect(result.error).toContain('16777216');
    expect(result.error).not.toContain('secret');
    expect(result.data).toBeUndefined();
    expect(result.truncated).toBeUndefined();
});

it('defaults legacy missing structured limits to 100000 characters and rejects invalid declarations', async () => {
    const f = fixture();
    f.tool.maxResultSizeChars = undefined as never;
    f.call.mockResolvedValue({ data: { id: 'a'.repeat(110_000) } });
    expect(await f.service.invoke({ toolId: 'fixture', args: {}, resultMode: 'structured' }))
        .toMatchObject({ success: false, errorCode: 'OUTPUT_TOO_LARGE', recoverable: false });
    f.tool.maxResultSizeChars = NaN;
    expect(await f.service.invoke({ toolId: 'fixture', args: {}, resultMode: 'structured' }))
        .toMatchObject({ success: false, errorCode: 'INVALID_OUTPUT_LIMIT', recoverable: false });
});

it('checks cancellation, live enablement, timeouts and permissions before reconciliation', async () => {
    const f = fixture(), reconcile = vi.spyOn(f.tool, 'reconcile');
    const request = { toolId: 'fixture', args: {}, ...identity };
    const abort = new AbortController(); abort.abort();
    await expect(f.service.reconcile({ ...request, signal: abort.signal })).rejects.toThrow();
    for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) await expect(f.service.reconcile({ ...request, timeoutMs })).rejects.toThrow('timeout');
    vi.spyOn(f.tool, 'isEnabled').mockReturnValueOnce(false);
    await expect(f.service.reconcile(request)).rejects.toThrow('unavailable');
    vi.spyOn(f.tool, 'checkPermissions').mockResolvedValueOnce({ behavior: 'deny' });
    await expect(f.service.reconcile(request)).rejects.toThrow('original operation');
    expect(reconcile).not.toHaveBeenCalled();
});

it('does not rerun execution preconditions or rewrite arguments during recovery', async () => {
    const f = fixture(), reconcile = vi.spyOn(f.tool, 'reconcile');
    vi.spyOn(f.tool, 'validateInput').mockResolvedValue({ result: false, message: 'Destination already exists' });
    const request = { toolId: 'fixture', args: {}, ...identity };
    expect(await f.service.reconcile(request)).toMatchObject({ status: 'completed' });
    expect(reconcile).toHaveBeenCalledOnce();
    vi.spyOn(f.tool, 'checkPermissions').mockResolvedValueOnce({ behavior: 'allow', updatedInput: {} });
    await expect(f.service.reconcile(request)).rejects.toThrow('original operation');
    expect(reconcile).toHaveBeenCalledOnce();
});

it('does not accept a reconciliation result after cancellation or replacement during permission checks', async () => {
    const f = fixture(), request = { toolId: 'fixture', args: {}, ...identity }, abort = new AbortController();
    const reconcile = vi.spyOn(f.tool, 'reconcile').mockImplementationOnce(async () => { abort.abort(); return { status: 'retry' }; });
    await expect(f.service.reconcile({ ...request, signal: abort.signal })).rejects.toThrow();
    vi.spyOn(f.tool, 'checkPermissions').mockImplementationOnce(async () => { f.service.unregisterTool('fixture'); return { behavior: 'allow' }; });
    await expect(f.service.reconcile(request)).rejects.toThrow('replaced');
    expect(reconcile).toHaveBeenCalledOnce();
});

it('rejects structured values that JSON would silently change', async () => {
    const f = fixture();
    delete f.tool.outputSchema;
    for (const data of [{ value: undefined }, { value: NaN }, { value: () => {} }]) {
        f.call.mockResolvedValueOnce({ data } as never);
        expect(await f.service.invoke({ toolId: 'fixture', args: {}, resultMode: 'structured' })).toMatchObject({ success: false, errorCode: 'INVALID_OUTPUT', recoverable: false });
    }
});
