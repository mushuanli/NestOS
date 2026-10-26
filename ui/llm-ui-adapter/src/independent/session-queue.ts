import type {ICommandBus, SessionInstructionQueue} from '@itookit/llm-session/contracts';
import {InstructionQueuePanel} from '../components/InstructionQueuePanel';
import type {ImageChatOptions} from './image-chat-view';

interface SessionQueuePort {
    readonly commands: ICommandBus;
    readonly sessionId: string;
    current(): boolean;
    snapshot(): SessionInstructionQueue | undefined;
}

/** Queue storage and dispatch remain with the Session host. */
export function sessionQueueToolbar(queue: SessionQueuePort | undefined, options: ImageChatOptions) {
    let active = true;
    const updates = new Set<() => void>();
    const mount: ImageChatOptions['mountToolbar'] = queue ? (root, context) => {
        const borrowed = options.mountToolbar?.(root, context);
        const element = document.createElement('section'); root.append(element);
        const panel = new InstructionQueuePanel(element, queue.commands, queue.sessionId, () => active && queue.current());
        const update = () => {panel.update(queue.snapshot()); panel.setReadOnly(!active || !queue.current());};
        updates.add(update); update();
        return {update: state => {borrowed?.update?.(state); update();},
            destroy: async () => {updates.delete(update); panel.destroy(); element.remove(); await borrowed?.destroy();}};
    } : options.mountToolbar;
    return {mount, setActive(value: boolean) {active = value; for (const update of updates) update();}};
}
