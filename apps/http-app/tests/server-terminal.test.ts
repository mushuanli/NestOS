import {afterEach, describe, expect, it} from 'vitest';
import {NodeServerTerminals} from '../../node-host/src/terminal/server-terminals';
import type {ServerTerminal} from '@itookit/app-contracts/services';
import {RpcPeer, installViewProjections} from '@itookit/app-transport/application';

const hosts: NodeServerTerminals[] = [];
afterEach(async () => {await Promise.all(hosts.splice(0).map(host => host.dispose()));});
function host() {const value = new NodeServerTerminals(); hosts.push(value); return value;}
async function outputUntil(session: ServerTerminal, pattern: RegExp, cursor = 0) {
    let output = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const page = await session.readOutput(cursor); output += page.output; cursor = page.cursor;
        if (pattern.test(output)) return {output, cursor};
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Expected terminal output did not arrive');
}

describe('server Bash terminal', () => {
    it('keeps Bash state, displays stderr, and interrupts foreground jobs through real RPC', async () => {
        const terminals = host();
        let server!: RpcPeer;
        const client = new RpcPeer('client', call => server.handle(call), () => {}, installViewProjections);
        server = new RpcPeer('server', call => client.handle(call), () => {});
        try {
            const boot = await server.bootstrap(terminals); client.applyUpdates(boot.updates);
            const remote = client.decode(boot.value!) as NodeServerTerminals;
            const session = await remote.openTerminal();
            await session.sendInput("cd /tmp; export NESTOS_TERMINAL_TEST=state; printf '\\nREADY_MARKER\\n'\r");
            let page = await outputUntil(session, /\r?\nREADY_MARKER\r?\n/);
            await session.sendInput("printf '\\n%s:%s\\n' \"$PWD\" \"$NESTOS_TERMINAL_TEST\"; printf 'STDERR_MARKER\\n' >&2\r");
            page = await outputUntil(session, /\r?\nSTDERR_MARKER\r?\n/, page.cursor);
            expect(page.output).toContain('/tmp:state');
            await session.resizeTerminal(100, 35);
            await session.sendInput('sleep 60\r');
            await new Promise(resolve => setTimeout(resolve, 100));
            await session.sendInput('\x03');
            await session.sendInput("printf '\\nINTERRUPTED_MARKER\\n'\r");
            await outputUntil(session, /\r?\nINTERRUPTED_MARKER\r?\n/, page.cursor);
            await session.sendInput('exit 7\r');
            await expect.poll(async () => (await session.readOutput(0)).exited).toBe(true);
            expect((await session.readOutput(0)).exitCode).toBe(7);
            await session.dispose();
        } finally {await client.close(); await server.close();}
    }, 15000);

    it('bounds sessions and output, rejects invalid input, and closes live processes with the view', async () => {
        const terminals = host(), first = await terminals.openTerminal(), second = await terminals.openTerminal();
        await expect(terminals.openTerminal()).rejects.toMatchObject({code: 'EBUSY'});
        await expect(first.readOutput(-1)).rejects.toMatchObject({code: 'EINVAL'});
        await expect(first.resizeTerminal(0, 24)).rejects.toMatchObject({code: 'EINVAL'});
        await expect(first.sendInput('x'.repeat(16385))).rejects.toMatchObject({code: 'EINVAL'});
        await first.sendInput("head -c 400000 /dev/zero | tr '\\0' x; printf '\\nOVERFLOW_DONE\\n'\r");
        await expect.poll(async () => (await first.readOutput(0)).truncated).toBe(true);
        await terminals.dispose();
        await expect(first.sendInput('echo bad\r')).rejects.toMatchObject({code: 'EIO'});
        await expect(second.sendInput('echo bad\r')).rejects.toMatchObject({code: 'EIO'});
        await expect(terminals.openTerminal()).rejects.toMatchObject({code: 'EIO'});
    });
});

it('exposes server terminals only to administrator views and releases them on view closure', async () => {
    const {createApplicationRuntime} = await import('@itookit/app-core');
    const {MemoryBackend} = await import('@itookit/vfs-core');
    const {createHostedView} = await import('@itookit/node-host/http');
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', startupMode: 'interactive', digitalTwinAutoStart: false});
    const admin = await createHostedView(runtime), user = await createHostedView(runtime, true);
    try {
        expect(user.root.backend.serverTerminals).toBeUndefined();
        const session = await admin.root.backend.serverTerminals!.openTerminal();
        await admin.close();
        await expect(session.sendInput('echo forbidden\r')).rejects.toMatchObject({code: 'EIO'});
    } finally {await admin.close(); await user.close(); await runtime.dispose();}
}, 15000);
