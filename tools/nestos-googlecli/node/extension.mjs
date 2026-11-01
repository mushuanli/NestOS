import {connectionType} from './client.mjs';
import {collectGoogle} from './collect.mjs';

export function createTools({buildTool, z, connections}) {
    connections?.register(connectionType);
    let tail = Promise.resolve();
    const serial = action => {const result = tail.then(action); tail = result.catch(() => {}); return result;};
    const common = {sourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/).default('default'),
        connection: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/), directory: z.string().min(1).optional(),
        maxItems: z.number().int().min(1).max(500).default(100)};
    const mail = {query: z.string().min(1).max(2000).default('newer_than:30d -in:trash -in:spam')};
    const calendar = {calendarId: z.string().min(1).max(300).default('primary'), timeMin: z.string().optional(), timeMax: z.string().optional(),
        pastDays: z.number().int().min(0).max(180).default(7), futureDays: z.number().int().min(1).max(180).default(30)};
    const make = (name, inputSchema, service) => buildTool({name, version: '1', inputSchema, searchHint: 'Collect connected account resources',
        maxResultSizeChars: 8192, interruptBehavior: () => 'cancel',
        async description() {return 'Collect mail or calendar evidence with the current user’s connection. Resource selects the operation; parameter schemas remain distinct. Read-only upstream access and authorized local file writes.';},
        async prompt() {return this.description();},
        async call(args, context) {return {data: await serial(() => collectGoogle(service ?? (args.resource === 'mail' ? 'gmail' : 'calendar'), args, context, connections))};},
        async reconcile(args, context) {const parsed = inputSchema.parse(args); return {status: 'completed', data: await serial(() => collectGoogle(service ?? (parsed.resource === 'mail' ? 'gmail' : 'calendar'), parsed, context, connections))};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};},
    });
    const {directory: _legacyDirectory, ...source} = common;
    return [make('google.collect', z.discriminatedUnion('resource', [z.object({...source, ...mail, resource: z.literal('mail')}),
        z.object({...source, ...calendar, resource: z.literal('calendar')})])),
        // Existing published workflows keep their tool identities and explicit directories.
        make('google.gmail.collect', z.object({...common, ...mail}), 'gmail'),
        make('google.calendar.collect', z.object({...common, ...calendar}), 'calendar')];
}
