// next.config.js - Complete example with both SWC plugin and webpack plugin
const createSWCPlugin = require("@codepress/codepress-engine/swc");
const CodePressWebpackPlugin = require("@codepress/codepress-engine/webpack-plugin");

module.exports = {
  // SWC plugin for code transformation (per-file)
  experimental: {
    swcPlugins: [
      createSWCPlugin(), // Your existing SWC plugin
    ],
  },

  // Webpack plugin for module ID mapping (post-bundling)
  webpack: (config, { isServer, dev }) => {
    // Plugin automatically skips if isServer or dev is true
    config.plugins.push(new CodePressWebpackPlugin({ isServer, dev }));
    return config;
  },
};
