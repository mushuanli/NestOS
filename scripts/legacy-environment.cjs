/** Runtime scripts have no application dependency graph; retain legacy service environment names. */
function legacyEnvironment(env) {
    const result = {...env};
    for (const [key, value] of Object.entries(env)) if (key.startsWith('MINDOS_')) result['NESTOS_' + key.slice(7)] ??= value;
    return result;
}
module.exports = {legacyEnvironment};
