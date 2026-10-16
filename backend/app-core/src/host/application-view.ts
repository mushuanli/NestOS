import type { ApplicationRuntime } from '../runtime/create-application-runtime';
import { bindLocalApplicationServices } from './application-services';
import { createApplicationClient, type ApplicationViewOptions } from './application-client';

/** Each client owns its bindings; execution and persistent services belong to the runtime. */
export async function openApplicationView(runtime: ApplicationRuntime, options: ApplicationViewOptions = {}) {
    const conversation = await runtime.createView();
    let closing: Promise<void> | undefined;
    try {
        const client = createApplicationClient({...bindLocalApplicationServices(runtime),
            sessionManager: conversation.sessionManager, commandBus: conversation.commandBus}, options);
        return {...client, close: () => closing ??= (async () => {
            try { await client.close(); } finally { await conversation.dispose(); }
        })()};
    } catch (error) { await conversation.dispose(); throw error; }
}
