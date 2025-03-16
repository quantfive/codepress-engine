// codepress-html-babel-plugin
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');

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
    backendUrl = process.env.CODEPRESS_BACKEND_URL || 'http://localhost:8000',
    repositoryId = process.env.CODEPRESS_REPOSITORY_ID,
    apiToken = process.env.CODEPRESS_API_TOKEN,
    branch = process.env.CODEPRESS_BRANCH || 'main',
    syncWithBackend = false
  } = options;
  
  // We'll keep a mapping to store ID -> real path
  let fileMapping = {};
  
  // Function to send file mappings to the backend
  const syncFileMappingsWithBackend = (mappings) => {
    // Skip if sync is disabled or required config is missing
    if (!syncWithBackend || !repositoryId || !apiToken) {
      if (syncWithBackend) {
        console.log('\x1b[33m⚠ Codepress backend sync disabled: missing repositoryId or apiToken\x1b[0m');
      }
      return;
    }
    
    const endpoint = `${backendUrl}/api/bulk-file-mappings`;
    const payload = JSON.stringify({
      repository_id: parseInt(repositoryId, 10),
      branch,
      mappings
    });
    
    const isHttps = endpoint.startsWith('https');
    const requestLib = isHttps ? https : require('http');
    const url = new URL(endpoint);
    
    // Use API key authentication - the apiToken is an organization API key
    // created in the CodePress backend with file_mappings permission
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${apiToken}`
      }
    };
    
    const req = requestLib.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`\x1b[32m✓ Codepress file mappings synced with backend successfully\x1b[0m`);
      } else {
        console.error(`\x1b[31m✗ Error syncing file mappings with backend: ${res.statusCode}\x1b[0m`);
        
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          console.error(`\x1b[31m  Response: ${data}\x1b[0m`);
        });
      }
    });
    
    req.on('error', (error) => {
      console.error(`\x1b[31m✗ Error syncing file mappings with backend: ${error.message}\x1b[0m`);
    });
    
    req.write(payload);
    req.end();
  };
  
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
        
        // Sync with backend if enabled
        syncFileMappingsWithBackend(fileMapping);
      } catch (error) {
        console.error(`\x1b[31m✗ Error writing Codepress file mapping: ${error.message}\x1b[0m`);
      }
    },
  };
};
