/**
 * Renderer entry point.
 *
 * This is a browser context: no Node, no Electron, no filesystem. Everything
 * the UI can do goes through `window.apollo`, the contextBridge surface
 * described by `ApolloBridge` in `@apollo/protocol`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApolloProviders } from './components/providers';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Apollo: #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/* Tooltip context and the toast outlet. Above `App`, not inside it, so a
        rewrite of the feature tree cannot take the design system's context
        with it — see `components/providers.tsx`. */}
    <ApolloProviders>
      <App />
    </ApolloProviders>
  </StrictMode>,
);
