// babel.config.js usage example

module.exports = {
  plugins: [
    // Default usage - uses auto-detected git repo and branch
    require("@quantfive/codepress-engine/babel"),
  ],
};

// With custom options:
// module.exports = {
//   plugins: [
//     [require('@quantfive/codepress-engine/babel'), {
//       attributeName: 'custom-file-path',
//       repoAttributeName: 'custom-repo-name',
//       branchAttributeName: 'custom-branch-name'
//     }]
//   ]
// };
