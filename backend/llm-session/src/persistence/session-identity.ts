import {ulid} from './ulid';
/** Reserve the same Session identity before committing a host-owned creation intent. */
export function createSessionId(): string {return `node-${ulid()}`;}
