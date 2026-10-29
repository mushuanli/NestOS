import {connectionType} from './client.mjs';
import {collectGoogle} from './collect.mjs';

export function createTools({buildTool, z, connections}) {
    connections?.register(connectionType);
    let tail = Promise.resolve();
    const serial = action => {const result = tail.then(action); tail = result.catch(() => {}); return result;};
    const common = {sourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/).default('default'), connection: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/), directory: z.string().min(1),
        maxItems: z.number().int().min(1).max(500).default(100)};
    return ['gmail', 'calendar'].map(service => buildTool({name: 'google.' + service + '.collect', version: '1',
        searchHint: 'Collect Google ' + service + ' evidence', maxResultSizeChars: 8192, interruptBehavior: () => 'cancel',
        inputSchema: z.object({...common, ...(service === 'gmail' ? {query: z.string().min(1).max(2000).default('newer_than:30d -in:trash -in:spam')}
            : {calendarId: z.string().min(1).max(300).default('primary'), timeMin: z.string().optional(), timeMax: z.string().optional(), pastDays: z.number().int().min(0).max(180).default(7), futureDays: z.number().int().min(1).max(180).default(30)})}),
        async description() {return 'Read a bounded complete ' + service + ' snapshot using this user’s private Google connection. Save stable evidence files in the authorized workspace; never send, delete or modify Google data. Narrow the range if the item cap is exceeded.';},
        async prompt() {return this.description();},
        async call(args, context) {return {data: await serial(() => collectGoogle(service, args, context, connections))};},
        // Remote reads and stable local overwrites can be repeated after interruption.
        async reconcile(args, context) {return {status: 'completed', data: await serial(() => collectGoogle(service, this.inputSchema.parse(args), context, connections))};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};},
    }));
}
