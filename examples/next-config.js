// next.config.js usage example for Next.js 15 (SWC compiler)
const createSWCPlugin = require("@codepress/codepress-engine/swc");

module.exports = {
  experimental: {
    swcPlugins: [
      // Automatically detects git repo and branch!
      createSWCPlugin(),
    ],
  },
};

// With custom options:
// module.exports = {
//   experimental: {
//     swcPlugins: [
//       createSWCPlugin({
//         repo_name: 'custom-org/custom-repo',
//         branch_name: 'custom-branch'
//       })
//     ]
//   }
// };
