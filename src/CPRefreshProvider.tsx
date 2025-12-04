/**
 * CPRefreshProvider - Root-level refresh provider for CodePress HMR
 *
 * NOTE: By default, you don't need to manually add this provider.
 * The CodePress SWC/Babel plugin automatically injects it at app entry points:
 * - Next.js Pages Router: pages/_app.tsx
 * - Next.js App Router: app/layout.tsx
 * - Vite/CRA: src/main.tsx or src/index.tsx
 *
 * When `window.__CP_triggerRefresh()` is called, all components under this provider will re-render.
 *
 * To disable auto-injection, set `autoInjectRefreshProvider: false` in the plugin config:
 * ```js
 * // next.config.js
 * experimental: {
 *   swcPlugins: [['@codepress/codepress-engine/swc', { autoInjectRefreshProvider: false }]]
 * }
 * ```
 *
 * Then manually add the provider:
 * ```tsx
 * import { CPRefreshProvider } from '@codepress/codepress-engine/refresh-provider';
 *
 * export default function App({ children }) {
 *   return <CPRefreshProvider>{children}</CPRefreshProvider>;
 * }
 * ```
 */

import React, { createContext, useSyncExternalStore, ReactNode } from 'react';

// Module-level version counter that persists across renders
let __cpVersion = 0;

// Context for components that want to subscribe to refresh events
export const CPRefreshContext = createContext<number>(0);

interface CPRefreshProviderProps {
  children: ReactNode;
}

/**
 * Root-level provider that triggers re-renders when CP_PREVIEW_REFRESH event fires.
 * Only one instance of this provider is needed at the app root.
 */
export function CPRefreshProvider({ children }: CPRefreshProviderProps) {
  const version = useSyncExternalStore(
    (callback) => {
      if (typeof window === 'undefined') {
        return () => {};
      }

      const handler = () => {
        __cpVersion = __cpVersion + 1;
        callback();
      };

      window.addEventListener('CP_PREVIEW_REFRESH', handler);

      // Also expose the trigger function globally
      if (!window.__CP_triggerRefresh) {
        window.__CP_triggerRefresh = () => {
          window.dispatchEvent(new CustomEvent('CP_PREVIEW_REFRESH'));
        };
        // Mark that this function dispatches the preview event
        (window.__CP_triggerRefresh as any).__cp_dispatches_preview = true;
      }

      return () => {
        window.removeEventListener('CP_PREVIEW_REFRESH', handler);
      };
    },
    () => __cpVersion,
    () => 0 // Server snapshot
  );

  return (
    <CPRefreshContext.Provider value={version}>
      {children}
    </CPRefreshContext.Provider>
  );
}

// Extend Window interface for TypeScript
declare global {
  interface Window {
    __CP_triggerRefresh?: () => void;
  }
}

export default CPRefreshProvider;
