// Scrub before services are constructed. Bundling can evaluate external imports first;
// the pinned SDK reads authentication only when its APIs are called, not on import.
import { scrubEnv } from './env';
import { captureLaunchAuthenticationEnvironment } from './authenticationEnvironment';

captureLaunchAuthenticationEnvironment(process.env);
scrubEnv(process.env);
