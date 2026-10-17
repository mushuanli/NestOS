// @file: llm-ui/components/tty/TtyController.ts
//
// TtyController — manages TtyPanel instances across multiple TTY sessions.
//
// Owned by HistoryView, which injects a getNode callback to find DOM containers.
// Receives metaInfo dispatches from handleBatchedEvents() and creates / updates /
// finalizes TtyPanel widgets accordingly.

import { TtyPanel } from './TtyPanel';

type TtyOpenMeta  = { sessionId: string; command: string; pid?: number };
type TtyDataMeta  = { sessionId: string; chunk: string };
type TtyCloseMeta = { sessionId: string; exitCode: number | null };

/** Callback to resolve a node ID to its DOM element. */
type GetNodeFn = (nodeId: string) => HTMLElement | undefined;

export class TtyController {
    private panels = new Map<string, TtyPanel>();

    constructor(private readonly getNode: GetNodeFn) {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleMeta(nodeId: string, metaInfo: Record<string, any>): void {
        const open  = metaInfo.ttyOpen  as TtyOpenMeta  | undefined;
        const data  = metaInfo.ttyData  as TtyDataMeta  | undefined;
        const close = metaInfo.ttyClose as TtyCloseMeta | undefined;

        if (open)  this.onOpen(nodeId, open.sessionId, open.command, open.pid);
        if (data)  this.onData(data.sessionId, data.chunk);
        if (close) this.onClose(close.sessionId, close.exitCode);
    }

    destroyAll(): void {
        this.panels.forEach(p => p.destroy());
        this.panels.clear();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private onOpen(nodeId: string, sessionId: string, command: string, pid?: number): void {
        if (this.panels.has(sessionId)) return; // idempotent

        const nodeEl = this.getNode(nodeId);
        const container = nodeEl?.querySelector('.llm-ui-node__tty-panels') as HTMLElement | null;
        if (!container) return;

        const panel = new TtyPanel(container, sessionId, command, pid);
        this.panels.set(sessionId, panel);
    }

    private onData(sessionId: string, chunk: string): void {
        this.panels.get(sessionId)?.appendOutput(chunk);
    }

    private onClose(sessionId: string, exitCode: number | null): void {
        this.panels.get(sessionId)?.finalize(exitCode);
        // Panel stays in map (read-only state) until destroyAll on session clear.
    }
}
