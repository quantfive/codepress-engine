export interface CodePressPluginOptions {
  repo_name?: string;
  branch_name?: string;
  skip_components?: string[];
  skip_member_roots?: string[];
  /**
   * Array of file patterns to exclude from transformation.
   * Supports glob patterns (e.g., "**\/FontProvider.tsx", "**\/providers/**")
   */
  exclude?: string[];
  /**
   * Environment variables to inject into the page as window.__CP_ENV_MAP__.
   * Auto-collected from NEXT_PUBLIC_* env vars if not provided.
   * Used by CodePress HMR to substitute env vars in dynamically built modules.
   */
  env_vars?: Record<string, string>;
  /**
   * Store metadata in window.__CODEPRESS_MAP__ instead of DOM attributes.
   * When true, only codepress-data-fp attribute is added to DOM.
   * This avoids React reconciliation issues and keeps DOM clean.
   * Defaults to true.
   */
  useJsMetadataMap?: boolean;
  /**
   * Automatically inject the refresh provider at detected app entry points.
   * Defaults to true.
   *
   * When enabled, the plugin detects and wraps these entry points:
   * - Next.js Pages Router: pages/_app.tsx
   * - Next.js App Router: app/layout.tsx (root layout)
   * - Vite/CRA: src/main.tsx or src/index.tsx
   *
   * Set to false to disable auto-injection. You'll need to manually add
   * the refresh provider:
   *
   * ```tsx
   * import { CPRefreshProvider } from '@codepress/codepress-engine/refresh-provider';
   *
   * export default function App({ children }) {
   *   return <CPRefreshProvider>{children}</CPRefreshProvider>;
   * }
   * ```
   *
   * Reasons to disable:
   * - Monorepos with library packages that match entry point patterns
   * - Custom entry points not detected automatically
   * - Full control over where the provider is placed
   */
  autoInjectRefreshProvider?: boolean;
  /**
   * Skip wrapping custom components with __CPProvider.
   * When useJsMetadataMap is true (the default), this is automatically set to true.
   * @deprecated This is now automatically determined by useJsMetadataMap
   */
  skipProviderWrap?: boolean;
  /**
   * Skip wrapping custom components with <codepress-marker>.
   * Only used when useJsMetadataMap is false.
   */
  skipMarkerWrap?: boolean;
}
