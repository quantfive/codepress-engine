export interface CodePressPluginOptions {
  repo_name?: string;
  branch_name?: string;
  /**
   * Whether to stamp exported symbols with __CP_stamp metadata.
   * Defaults to true; can be disabled for environments that are sensitive to
   * eager evaluation of exports (e.g., complex circular import graphs).
   */
  stampExports?: boolean;
  /**
   * Whether to stamp JSX callsites (component variables used in JSX).
   * Defaults to true.
   */
  stampCallsites?: boolean;
}
