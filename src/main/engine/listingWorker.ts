// Electron utilityProcess entry (built to out/main/listingWorker.js). Serves ListingRequest messages.
// Started with buildChildEnv(profile), so the SDK and the transcript reader use that profile's CLAUDE_CONFIG_DIR.
import {
  deleteSession,
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { ListingRequest } from './listing';
import { runListingRequest, type ListingSdk } from './listingOps';

const port = process.parentPort;
const sdk: ListingSdk = { listSessions, getSessionMessages, getSubagentMessages, renameSession, forkSession, deleteSession };

port.on('message', (event) => {
  void runListingRequest(event.data as ListingRequest, sdk).then((response) => port.postMessage(response));
});
