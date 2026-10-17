import type { ServerResponse } from 'node:http';

/** A bounded journal bridges transport interruptions without recreating view capabilities. */
export class ViewEventStream {
    private frames: Array<{ id: number; frame: string; bytes: number }> = [];
    private bytes = 0;
    private sequence = 0;
    private includeIds = true;
    private stream?: ServerResponse;
    destroyed = false;
    get writableLength(): number { return this.stream?.writableLength ?? 0; }
    canResume(after: number): boolean {
        return !this.destroyed && Number.isSafeInteger(after) && after >= (this.frames[0]?.id ?? this.sequence + 1) - 1 && after <= this.sequence;
    }
    attach(stream: ServerResponse, after = 0, includeIds = true): void {
        this.stream?.end(); this.stream = stream; this.includeIds = includeIds;
        stream.once('close', () => { if (this.stream === stream) this.stream = undefined; });
        for (const entry of this.frames) if (entry.id > after) stream.write(includeIds ? entry.frame : entry.frame.slice(entry.frame.indexOf('\n') + 1));
    }
    write(data: string): boolean {
        if (this.destroyed) return false;
        const frame = `id: ${++this.sequence}\n${data}`, bytes = Buffer.byteLength(frame);
        if (bytes > 2 * 1024 * 1024 || this.writableLength > 1024 * 1024) { this.end(); return false; }
        this.frames.push({ id: this.sequence, frame, bytes }); this.bytes += bytes;
        while (this.frames.length > 256 || this.bytes > 2 * 1024 * 1024) this.bytes -= this.frames.shift()!.bytes;
        if (this.stream && !this.stream.destroyed) this.stream.write(this.includeIds ? frame : data);
        return true;
    }
    end(): void { this.destroyed = true; this.stream?.end(); this.stream = undefined; this.frames = []; this.bytes = 0; }
}
