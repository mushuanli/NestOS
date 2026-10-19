import './style.css';
import type { ChatOptions, ChatView } from './contracts';
import { ChatController } from './chat-view';

export type * from './contracts';
export {composeCommandCatalogs, parseCommand, isCommandInput} from './commands';
export { createOperationLedger } from './operations';
export {createInteractionCard} from './interactions';
export type {InteractionCard} from './interactions';
export type { OperationLedgerOptions } from './operations';
export { createContentSearch } from './search';
export type { ContentSearchOptions, ContentSearchView, SearchContent } from './search';

export async function createChatView(container: HTMLElement, options: ChatOptions): Promise<ChatView> {
    const controller = new ChatController(container, options);
    try { controller.initialize(); return controller; }
    catch (error) {
        try { await controller.destroy(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Chat initialization failed'); }
        throw error;
    }
}
