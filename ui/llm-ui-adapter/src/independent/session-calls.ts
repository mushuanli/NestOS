import type {ChatMessage, ExtensionRenderer, MessagePart, OperationLedger} from '@itookit/llm-ui';
import type {ICommandBus, IndependentCallView, SessionGroup} from '@itookit/llm-session/contracts';
import {IndependentCallPanel} from '../components/IndependentCallPanel';

export const independentCallPart = 'mindos.independent-call';
interface MountedCall {element: HTMLElement; call: IndependentCallView}

/** Host-owned cards become ephemeral extension parts, never persisted parent messages. */
export class SessionCallPresentation {
    readonly notices = document.createElement('div');
    private readonly calls = new Map<string, MountedCall>();
    private readonly panel: IndependentCallPanel;
    private closed = false;
    readonly renderer: ExtensionRenderer = (container, part) => {
        let element: HTMLElement | undefined;
        const mount = (value: typeof part) => {
            const id = (value.data as {callId?: unknown})?.callId;
            const entry = typeof id === 'string' && this.calls.get(id);
            if (!entry || this.closed) throw new Error('Independent call presentation expired');
            if (element !== entry.element && element?.parentElement === container) element.remove();
            element = entry.element; if (element.parentElement !== container) container.append(element);
        };
        mount(part);
        return {update: value => mount(value), destroy: () => {
            // A replaced renderer cannot detach a card that has already moved to its successor.
            if (element?.parentElement === container) element.remove();
        }};
    };
    constructor(commands: ICommandBus, sessionId: string, branch: () => string, operations: OperationLedger,
        changed: () => void, openChild?: (id: string) => void | Promise<void>) {
        this.panel = new IndependentCallPanel(commands, sessionId, this.notices, {operations, branch, openChild,
            mountCard: (element, call) => {
                const id = call.receipt.operationId;
                this.calls.set(id, {element, call}); changed();
                return () => {this.calls.delete(id); if (!this.closed) changed();};
            }});
    }
    merge(messages: readonly ChatMessage[], groups: readonly SessionGroup[]): ChatMessage[] {
        const buckets = new Map<number, MountedCall[]>(), anchors = new Map<string, number>();
        groups.forEach((group, index) => {
            for (const key of [group.roundId, group.persistedNodeId, group.id.replace(/^round-(.*)-(assistant|user)$/, '$1')])
                if (key) anchors.set(key, index);
        });
        for (const entry of [...this.calls.values()].sort((a, b) => a.call.createdAt - b.call.createdAt
            || a.call.receipt.operationId.localeCompare(b.call.receipt.operationId))) {
            const head = entry.call.head;
            const index = head === null ? -1 : anchors.get(head) ?? messages.length - 1;
            const items = buckets.get(index) ?? []; items.push(entry); buckets.set(index, items);
        }
        const result = (buckets.get(-1) ?? []).map(message);
        messages.forEach((item, index) => {result.push(item, ...(buckets.get(index) ?? []).map(message));});
        return result;
    }
    refresh(): Promise<void> {return this.panel.refresh();}
    setActive(active: boolean): void {this.panel.setVisible(active);}
    destroy(): void {if (this.closed) return; this.closed = true; this.panel.destroy(); this.calls.clear(); this.notices.remove();}
}
function message(entry: MountedCall): ChatMessage {
    const id = entry.call.receipt.operationId;
    const part: MessagePart = {id: 'call', kind: 'extension', type: independentCallPart, data: {callId: id}};
    return {id: `independent-call:${id}`, revision: 0, role: 'assistant', state: 'complete', parts: [part], timestamp: entry.call.createdAt};
}
