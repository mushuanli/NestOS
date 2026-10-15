import { RpcPeer as TransportPeer } from '../rpc/peer';
import { CAPABILITIES } from './capabilities';
import { installViewProjections } from './projections';

/** Application metadata and selectors are bound outside the transport mechanism. */
export class RpcPeer extends TransportPeer {
    constructor(...args: ConstructorParameters<typeof TransportPeer>) {
        const [side, send, report, projections = installViewProjections, prepare] = args;
        super(side, send, report, projections, prepare, CAPABILITIES);
    }
}
