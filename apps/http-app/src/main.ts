import { createStartupStatus } from './client/startup-status';
import {connectApplication} from './client/application-connection';
import {preloadBrowserEditor} from 'mind-os/preload';

const startup = createStartupStatus();
performance.mark('mindos:entry');
const connection = connectApplication();
void connection.ready.catch(() => {});
void Promise.all([import('./client/hosted-application'), preloadBrowserEditor(connection.editor)])
    .then(([module]) => module.startApplicationClient(message => startup.progress(message), () => startup.ready(), connection))
    .catch(async error => { await connection.close().catch(() => {}); console.error('[Bootstrap] Fatal:', error); startup.fail(error); });
