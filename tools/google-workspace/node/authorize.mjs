import {readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {jsonRequest} from './client.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
    index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
if (!args.client || !args.output || !['gmail', 'calendar', 'gmail,calendar'].includes(args.services ?? 'gmail,calendar')) {
    console.error('Usage: node authorize.mjs --client desktop-client.json --output private-connection.json --services gmail,calendar');
    process.exit(1);
}
const file = JSON.parse(await readFile(args.client, 'utf8')), config = file.installed;
if (!config?.client_id || !config.client_secret) throw new Error('A Google Desktop OAuth client JSON is required');
const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
const scopes = (args.services ?? 'gmail,calendar').split(',').map(service => 'https://www.googleapis.com/auth/'
    + (service === 'gmail' ? 'gmail.readonly' : 'calendar.events.readonly'));
let complete, reject;
const code = new Promise((resolve, failed) => {complete = resolve; reject = failed;});
const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {response.writeHead(400); response.end('Invalid OAuth callback'); return;}
    response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    if (!url.searchParams.get('code')) {response.end('Google authorization was declined.'); reject(new Error('GOOGLE_AUTH_DECLINED')); return;}
    response.end('Authorization received. Return to the terminal.'); complete(url.searchParams.get('code'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const redirect = 'http://127.0.0.1:' + server.address().port + '/callback';
const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
url.search = new URLSearchParams({client_id: config.client_id, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'});
console.info('Open this URL in your browser to authorize your own account:\n' + url);
const timer = setTimeout(() => reject(new Error('GOOGLE_AUTH_TIMEOUT')), 300000);
try {
    const token = await jsonRequest(fetch, 'https://oauth2.googleapis.com/token', {method: 'POST', signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({client_id: config.client_id, client_secret: config.client_secret, code: await code,
            code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code'})}, 'AUTH');
    if (!token.refresh_token) throw new Error('GOOGLE_REFRESH_TOKEN_MISSING');
    await writeFile(args.output, JSON.stringify({clientId: config.client_id, clientSecret: config.client_secret, refreshToken: token.refresh_token}, null, 2), {mode: 0o600, flag: 'wx'});
    console.info('Saved private connection file. Import it in your digital twin connections settings.');
} finally {clearTimeout(timer); server.closeAllConnections(); server.close();}
