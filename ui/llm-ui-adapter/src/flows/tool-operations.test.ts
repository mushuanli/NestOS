import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import type {IPrivilegedCommandService} from '@itookit/llm-session/contracts';
import {ToolCommandOperations} from './tool-operations';

it('persists before dispatch and reuses the same request after an unknown response and reload', async () => {
    const ledger = createOperationLedger();
    const tool = vi.fn(async () => {
        expect(ledger.getSnapshot()).toHaveLength(1);
        throw new Error('Reply lost');
    });
    const service = {tool} as unknown as IPrivilegedCommandService;
    const request = {sessionId: 's', toolId: 'fixture', toolVersion: '1', args: {body: 'value'}};
    await expect(new ToolCommandOperations(ledger, service).submit(request)).rejects.toThrow('Reply lost');
    const original = tool.mock.calls[0] as unknown as [unknown];
    const restored = createOperationLedger({initial: JSON.parse(JSON.stringify(ledger.getSnapshot()))});
    const resumedTool = vi.fn(async () => 'task');
    await expect(new ToolCommandOperations(restored, {tool: resumedTool} as unknown as IPrivilegedCommandService).submit(request)).resolves.toBe('task');
    expect(resumedTool).toHaveBeenCalledWith(original[0]);
    expect(restored.getSnapshot()[0]).toMatchObject({status: 'accepted', submissionRef: 'task'});
});
