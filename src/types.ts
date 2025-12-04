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
   * Skip wrapping custom components with __CPProvider.
   * Useful for frameworks that handle HMR differently (e.g., Next.js).
   */
  skipProviderWrap?: boolean;
  /**
   * Skip wrapping custom components with <codepress-marker>.
   * Only used when useJsMetadataMap is false.
   */
  skipMarkerWrap?: boolean;
}
