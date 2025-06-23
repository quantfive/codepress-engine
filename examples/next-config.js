// next.config.js usage example for Next.js 15 (SWC compiler)

module.exports = {
  experimental: {
    swcPlugins: [
      // Default usage - uses auto-detected git repo and branch
      ["@quantfive/codepress-engine/swc", {}],
    ],
  },
};

// With custom options:
// module.exports = {
//   experimental: {
//     swcPlugins: [
//       ['@quantfive/codepress-engine/swc', {
//         attributeName: 'custom-file-path',
//         repoAttributeName: 'custom-repo-name',
//         branchAttributeName: 'custom-branch-name'
//       }]
//     ]
//   }
// };
