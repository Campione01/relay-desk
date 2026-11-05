import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/transcript.css';
import './styles/markdown.css';
import './styles/prompt.css';
import './styles/panel.css';
import './styles/flows.css';
import './styles/nativePanel.css';
import './styles/tasks.css';
import { applyTheme } from './theme/theme';

// Resolve the system theme before the first paint; saved settings are applied once they load.
applyTheme('system');

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
