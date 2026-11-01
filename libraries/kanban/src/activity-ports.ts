import type {KanbanBoard, KanbanExecutionSession} from './contracts';
export interface KanbanSessionSource {
    authorizeBinding?(board: KanbanBoard, sessionId: string): Promise<void>;
    /** Must check access within the supplied board's user/project and authority. */
    inspect(board: KanbanBoard, sessionId: string): Promise<Omit<KanbanExecutionSession,'recent'>>;
}
