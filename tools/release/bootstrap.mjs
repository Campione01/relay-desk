for (const key of ['RELAY_DESK_NATIVE_PROTOTYPE', 'RELAY_NATIVE_FIXTURE_URL', 'RELAY_NATIVE_DENY_PROXY']) {
  if (process.env[key] !== undefined) throw new Error(`Normal Relay cannot inherit ${key}.`);
}
process.env.DISABLE_AUTOUPDATER = '1';
await import('./index.js');
