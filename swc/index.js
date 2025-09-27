const gitInfo = (() => {
  try {
    return require("../dist/git-info");
  } catch (err) {
    try {
      return require("../src/git-info");
    } catch (err2) {
      throw err;
    }
  }
})();

const { detectGitBranch, detectGitRepoName } = gitInfo;

/**
 * Creates SWC plugin configuration with auto-detected git information
 * @param {Object} userConfig - User-provided configuration options
 * @returns {Array} SWC plugin configuration array
 */
function createSWCPlugin(userConfig = {}) {
  // Auto-detect git information
  const repoName = detectGitRepoName();
  const branchName = detectGitBranch();

  // Merge with user config
  const config = {
    repo_name: repoName,
    branch_name: branchName,
    runtime_registration: true,
    runtime_global:
      userConfig.runtime_global || "__CODEPRESS_COMPONENT_REGISTRATIONS__",
    runtime_flush_callback:
      userConfig.runtime_flush_callback ||
      process.env.CODEPRESS_RUNTIME_FLUSH_CALLBACK ||
      "__CODEPRESS_COMPONENTS_FLUSH__",
    ...userConfig,
  };

  // Return the plugin configuration array
  return ["@quantfive/codepress-engine/swc/wasm", config];
}

// Support both CommonJS and ES6 imports
module.exports = createSWCPlugin;
