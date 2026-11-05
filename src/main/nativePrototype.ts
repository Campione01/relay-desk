import { app } from 'electron';
import { join, parse } from 'node:path';
import { initializePrototypeEnvironment, PROTOTYPE_NAME } from './native/isolation';

// Set every storage location before importing services or acquiring the single-instance lock.
const base = process.env.LOCALAPPDATA;
if (!base) throw new Error('LOCALAPPDATA is required for the isolated prototype.');
// Native project instructions walk ancestors, so a fixture cannot live under the real user home.
const paths = initializePrototypeEnvironment(process.env.RELAY_NATIVE_SANDBOX_ROOT ?? join(parse(base).root, 'RelayDeskNativePrototype', 'app-preview'));
app.setName(PROTOTYPE_NAME);
app.setPath('userData', paths.userData);
app.setPath('sessionData', paths.session);
app.setPath('home', paths.home);
app.setPath('temp', paths.temp);
app.setPath('appData', paths.roaming);
app.setPath('logs', paths.logs);
app.setPath('crashDumps', paths.crashes);
await import('./index');
