# codepress-html-babel-plugin

A Babel plugin that adds file identifiers to JSX elements for visual editing with Codepress.

## Installation

```bash
npm install --save-dev codepress-html-babel-plugin
```

## Usage

Add the plugin to your Babel configuration:

```javascript
// babel.config.js
module.exports = {
  plugins: [
    'codepress-html-babel-plugin'
  ]
};
```

### With options

```javascript
// babel.config.js
module.exports = {
  plugins: [
    ['codepress-html-babel-plugin', {
      // File output options
      outputPath: 'custom-file-map.json', // default: 'file-hash-map.json'
      attributeName: 'data-fp', // default: 'codepress-data-fp'
      
      // Backend sync options
      syncWithBackend: true, // default: false - enables syncing with CodePress backend
      backendUrl: 'https://api.codepress.example.com', // default: process.env.CODEPRESS_BACKEND_URL or 'http://localhost:8000'
      repositoryId: '123', // default: process.env.CODEPRESS_REPOSITORY_ID
      apiToken: 'your-api-token', // default: process.env.CODEPRESS_API_TOKEN
      branch: 'main' // default: process.env.CODEPRESS_BRANCH or 'main'
    }]
  ]
};
```

### Environment Variables for Backend Sync

Instead of hardcoding values in the Babel config, you can use environment variables:

```bash
# .env or export in your shell
CODEPRESS_BACKEND_URL=https://api.codepress.example.com
CODEPRESS_REPOSITORY_ID=123
CODEPRESS_API_TOKEN=your-organization-api-key
CODEPRESS_BRANCH=main
```

The `CODEPRESS_API_TOKEN` should be an Organization API Key created in the CodePress backend with `file_mappings` permission. This allows CI/CD systems to update file mappings without needing user credentials.

Then in your babel config:

```javascript
module.exports = {
  plugins: [
    ['codepress-html-babel-plugin', {
      syncWithBackend: true // Use environment variables for connection details
    }]
  ]
};
```

## How it works

This plugin:

1. Generates a unique hash for each file processed by Babel
2. Adds a custom attribute to all JSX opening elements with the file's hash
3. Creates a mapping file (file-hash-map.json) that connects hashes to file paths
4. Optionally syncs the file mappings with a CodePress backend server

This allows tools like CodePress to identify which React component file corresponds to rendered HTML elements, enabling visual editing capabilities.

### Backend Sync

When `syncWithBackend` is enabled, the plugin will:

1. Generate the local file-hash-map.json file as usual
2. Make a POST request to `{backendUrl}/api/bulk-file-mappings` with the file mappings
3. Include repository ID, branch, and API key in the request
4. Log the result of the sync operation

This enables the CodePress browser extension to correlate DOM elements with source files when editing websites, without needing direct access to the source code.

#### How to Set Up Backend Sync

1. In the CodePress backend, go to your GitHub organization settings
2. Navigate to the API Keys section
3. Create a new API key with `file_mappings` permission
4. Note the API key value (it will only be shown once)
5. Configure your build process with the API key:
   - Set `CODEPRESS_API_TOKEN` environment variable, or
   - Add the API key to your babel config

This allows your build system to automatically update file mappings whenever your code is built, keeping the CodePress backend in sync with the latest file locations.

## License

MIT
