import type {ConversationCommandOutput} from '@itookit/ui-common';
import {NativeCommandOutput, type CommandOutputReader} from './NativeCommandOutput';

export interface NativeOutputPlacement {id: string; parent: HTMLElement; output: ConversationCommandOutput}

/** Stable output mounts follow the message anchor, independently of Markdown rerenders. */
export class NativeCommandOutputs {
    private readonly views = new Map<string, NativeCommandOutput>();
    private disposed = false;
    private active = true;
    constructor(private readonly reader: CommandOutputReader) {}
    show(placements: NativeOutputPlacement[]): void {
        if (this.disposed) return;
        const ids = new Set(placements.map(item => item.id));
        for (const [id, view] of this.views) {if (!ids.has(id)) {view.destroy(); this.views.delete(id);}}
        for (const placement of placements) {
            let view = this.views.get(placement.id);
            if (!view) {view = new NativeCommandOutput(this.reader); view.setActive(this.active); this.views.set(placement.id, view);}
            view.update(placement.output); placement.parent.append(view.element);
        }
    }
    setActive(active: boolean): void {this.active = active; for (const view of this.views.values()) view.setActive(active);}
    destroy(): void {this.disposed = true; for (const view of this.views.values()) view.destroy(); this.views.clear();}
}
