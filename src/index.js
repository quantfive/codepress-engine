// codepress-html-babel-plugin
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/**
 * Babel plugin that adds unique file identifiers to JSX elements
 * This enables visual editing tools to map rendered HTML back to source files
 */
module.exports = function(babel, options = {}) {
  const t = babel.types;
  
  // Default options
  const {
    outputPath = 'file-hash-map.json',
    attributeName = 'codepress-data-fp',
  } = options;
  
  // We'll keep a mapping to store ID -> real path
  let fileMapping = {};
  
  return {
    name: 'codepress-html-babel-plugin',
    visitor: {
      Program(path, state) {
        // This runs once per file
        const fullFilePath = state.file.opts.filename || '';
        // Normalize to relative path from cwd
        const relFilePath = path.relative(process.cwd(), fullFilePath);

        // Skip node_modules files
        if (relFilePath.includes('node_modules')) return;
        
        // Create a short hash of the relative path
        const hash = crypto
          .createHash('sha1')
          .update(relFilePath)
          .digest('hex')
          .substring(0, 8);
        
        // Store mapping
        fileMapping[hash] = {
          filePath: relFilePath,
        };
        
        // Save hash in file state for other visitors to access
        state.file.fileHash = hash;
      },

      JSXOpeningElement(path, state) {
        const fileHash = state.file.fileHash;
        if (!fileHash) return;

        // Insert attribute if not present
        const { node } = path;
        const hasAttribute = node.attributes.some((attr) => {
          return (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: attributeName })
          );
        });

        if (!hasAttribute) {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(attributeName),
              t.stringLiteral(fileHash)
            )
          );
        }
      },
    },
    
    // Runs after all files are processed
    post() {
      // Write the mapping file
      try {
        fs.writeFileSync(
          outputPath,
          JSON.stringify(fileMapping, null, 2)
        );
        console.log(`\x1b[32m✓ Codepress file mapping written to ${outputPath}\x1b[0m`);
      } catch (error) {
        console.error(`\x1b[31m✗ Error writing Codepress file mapping: ${error.message}\x1b[0m`);
      }
    },
  };
};
