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
}
