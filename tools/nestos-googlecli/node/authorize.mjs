import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomBytes, createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {jsonRequest} from './client.mjs';
import {prepareOptions, usage, inputError} from './authorize-input.mjs';
import {configureAuthorizationNetwork, authorizationErrorMessage} from './authorize-network.mjs';

/** The callback stays on the computer running this helper, independently of httpd. */
export async function authorizeGoogle(options, {fetcher = fetch, showUrl = url => console.info('请用本机浏览器打开以下链接，选择账号并同意授权：\n' + url), timeoutMs = 300000, onStage = () => {}} = {}) {
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    let complete, reject;
    const code = new Promise((resolve, failed) => {complete = resolve; reject = failed;});
    code.catch(() => {});
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {response.writeHead(400); response.end('Invalid OAuth callback'); return;}
        if (!url.searchParams.get('code')) {response.end('授权未完成，可以返回终端重试。'); reject(inputError('GOOGLE_AUTH_DECLINED', '你未同意 Google 授权，可以重新运行命令。')); return;}
        response.end('已收到授权，请返回终端查看保存结果。'); complete(url.searchParams.get('code'));
    });
    onStage('callback-listen');
    await new Promise((resolve, failed) => {server.once('error', failed); server.listen(0, '127.0.0.1', resolve);});
    const redirect = 'http://127.0.0.1:' + server.address().port + '/callback';
    const timer = setTimeout(() => reject(inputError('GOOGLE_AUTH_TIMEOUT', '等待授权超时，请重新运行命令，并在本机浏览器完成授权。')), timeoutMs);
    try {
        const url = authorizationUrl(options, redirect, state, verifier);
        await showUrl(url);
        onStage('callback-wait'); const authorizationCode = await code;
        onStage('token-exchange'); const token = await exchange(options.config, authorizationCode, redirect, verifier, fetcher);
        if (!token.refresh_token) throw inputError('GOOGLE_REFRESH_TOKEN_MISSING', 'Google 未返回离线授权，请撤销此应用的旧授权后重新运行。');
        onStage('output-write'); await writeFile(options.output, JSON.stringify({clientId: options.config.client_id, clientSecret: options.config.client_secret, refreshToken: token.refresh_token}, null, 2), {mode: 0o600, flag: 'wx'});
    } finally {clearTimeout(timer); server.closeAllConnections(); server.close();}
}
function authorizationUrl(options, redirect, state, verifier) {
    const scopes = options.services.split(',').map(service => 'https://www.googleapis.com/auth/' + (service === 'gmail' ? 'gmail.readonly' : 'calendar.events.readonly'));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({client_id: options.config.client_id, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '),
        access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'});
    return url.href;
}
function exchange(config, code, redirect, verifier, fetcher) {
    return jsonRequest(fetcher, 'https://oauth2.googleapis.com/token', {method: 'POST', signal: AbortSignal.timeout(30000),
        body: new URLSearchParams({client_id: config.client_id, client_secret: config.client_secret, code,
            code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code'})}, 'AUTH');
}
async function main() {
    const operationId = randomUUID(), started = Date.now(); let stage = 'client-input', restoreNetwork = () => {};
    try {
        const options = await prepareOptions(process.argv.slice(2));
        if (options.help) {console.info(usage); return;}
        stage = 'network-setup'; restoreNetwork = configureAuthorizationNetwork();
        await authorizeGoogle(options, {onStage: value => {stage = value;}});
        console.info('授权成功，文件已保存到：\n' + options.output);
        console.info('在这台电脑的浏览器打开 NestOS → 工具包 → 我的数据连接 → 本机授权后导入（无需域名）。\n导入上面的文件并保存（可自行修改连接名称）。httpd 可在另一台机器；后续采集不需要此电脑保持开启。');
        console.info('[Google OAuth]', {operationId, stage: 'complete', result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = typeof error.code === 'string' && /^(GOOGLE_[A-Z_]+|E[A-Z]+)$/.test(error.code) ? error.code : 'GOOGLE_AUTH_FAILED';
        const message = authorizationErrorMessage(error);
        console.error(message + '\n错误代码：' + code);
        console.error('[Google OAuth]', {operationId, stage, result: 'failure', code, networkCode: error.networkCode, durationMs: Date.now() - started}); process.exitCode = 1;
    } finally {restoreNetwork();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
