import { createStartupStatus } from './client/startup-status';
import { startApplicationClient } from './client/hosted-application';

const startup = createStartupStatus();
startApplicationClient(message => startup.progress(message)).then(() => startup.ready())
    .catch(error => { console.error('[Bootstrap] Fatal:', error); startup.fail(error); });
