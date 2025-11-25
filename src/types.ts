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
}
