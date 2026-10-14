import type { SessionHandle, SharedLeaseCondition, TaskHandle } from '@itookit/durable-kernel';

/** Guard scheduler submissions and shared records without changing Task identity fingerprints. */
export function fenceSchedulerSession(session: SessionHandle, condition: SharedLeaseCondition): SessionHandle {
    const lease = Object.freeze({ ...condition });
    const fenced = Object.create(session) as SessionHandle;
    fenced.submit = async (spec, options) => fenceTask(await session.submit(spec, { ...options, lease }), lease);
    fenced.attachTask = async taskId => fenceTask(await session.attachTask(taskId), lease);
    fenced.setBudget = (id, dimension, limit, version, options) => session.setBudget(id, dimension, limit, version, { ...options, lease });
    fenced.respond = (taskId, response, options) => session.respond(taskId, response, { ...options, lease });
    fenced.signal = (taskId, signal, options) => session.signal(taskId, signal, { ...options, lease });
    fenced.setShared = (key, value, options) => session.setShared(key, value, { ...options, lease });
    fenced.deleteShared = (key, options) => session.deleteShared(key, { ...options, lease });
    return fenced;
}


function fenceTask<O>(task: TaskHandle<O>, lease: SharedLeaseCondition): TaskHandle<O> {
    const fenced = Object.create(task) as TaskHandle<O>;
    fenced.respond = (response, options) => task.respond(response, { ...options, lease });
    fenced.cancel = (reason, options) => task.cancel(reason, { ...options, lease });
    fenced.pause = options => task.pause({ ...options, lease });
    fenced.interrupt = options => task.interrupt({ ...options, lease });
    fenced.resume = options => task.resume({ ...options, lease });
    fenced.start = options => task.start({ ...options, lease });
    fenced.signal = (signal, options) => task.signal(signal, { ...options, lease });
    fenced.createResource = (spec, options) => task.createResource(spec, { ...options, lease });
    fenced.retry = async options => fenceTask(await task.retry({ ...options, lease }), lease);
    return fenced;
}
