import * as http from 'node:http';
import {inputError} from './authorize-input.mjs';

/** Configure only the standalone helper; never replace the host application's dispatcher. */
export function configureAuthorizationNetwork(env = process.env, configure = http.setGlobalProxyFromEnv, args = process.execArgv) {
    const proxied = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'].some(key => !!env[key]);
    if (!proxied || env.NODE_USE_ENV_PROXY === '0') return () => {};
    if (typeof configure !== 'function') {
        if (env.NODE_USE_ENV_PROXY === '1' || args.includes('--use-env-proxy')) return () => {};
        throw inputError('GOOGLE_PROXY_RUNTIME_REQUIRED', '检测到环境代理。请使用 Node 24.14+，或在支持的版本上运行：node --use-env-proxy tools/nestos-googlecli/node/authorize.mjs');
    }
    try {return configure(env);}
    catch {throw inputError('GOOGLE_PROXY_CONFIGURATION_INVALID', '环境代理配置无效。请检查 HTTPS_PROXY / https_proxy 是否为可用的 HTTP 或 HTTPS 代理地址。');}
}

export function authorizationErrorMessage(error) {
    if (error.code === 'GOOGLE_AUTH_NETWORK' || error.code === 'GOOGLE_CANCELLED') {
        const reason = {
            ENOTFOUND: 'DNS 无法解析目标地址', EAI_AGAIN: 'DNS 暂时不可用', ECONNREFUSED: '连接被拒绝，请检查代理是否启动',
            ECONNRESET: '连接被中断', ETIMEDOUT: '连接超时', UND_ERR_CONNECT_TIMEOUT: '连接超时',
            UND_ERR_HEADERS_TIMEOUT: '等待响应超时', TIMEOUT: '请求超时', CERT_HAS_EXPIRED: 'TLS 证书已过期',
            DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任', SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书链不受信任',
            UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证', ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配',
        }[error.networkCode] ?? '网络请求未能完成';
        return `未能向 Google 换取令牌：${reason}。浏览器回调成功不代表凭据已保存。请检查运行命令的终端能否通过其网络或代理访问 oauth2.googleapis.com，然后重新运行命令并打开新链接授权。`;
    }
    return error.code?.startsWith('GOOGLE_') && error.message !== error.code ? error.message : '授权未完成，请检查网络、文件权限或 Google 应用配置后重试。';
}
