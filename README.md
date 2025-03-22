# babel-plugin-codepress-html

A Babel plugin that adds file identifiers to JSX elements for visual editing with Codepress.

## Installation

```bash
npm install --save-dev babel-plugin-codepress-html
```

## Usage

Add the plugin to your Babel configuration:

```javascript
// babel.config.js
module.exports = {
  plugins: [
    'codepress-html'  // Babel will resolve this to babel-plugin-codepress-html
  ]
};
```

### With options

```javascript
// babel.config.js
module.exports = {
  plugins: [
    ['codepress-html', {  // Babel will resolve this to babel-plugin-codepress-html
      // File output options
      outputPath: 'custom-file-map.json', // default: 'file-hash-map.json'
      attributeName: 'data-fp', // default: 'codepress-data-fp'
      
      // Database connection options 
      backendUrl: 'https://api.codepress.example.com', // default: auto-detects based on environment
      repositoryId: '123', // optional - auto-detects from git remote URL if not specified
      apiToken: 'your-api-token', // required for database saving
      branch: 'main', // optional - auto-detects from git if not specified
      environment: 'production' // optional - auto-detects based on NODE_ENV
    }]
  ]
};
```

### Backend Sync Configuration

For syncing with the CodePress backend, provide the connection details in your Babel config:

```javascript
module.exports = {
  plugins: [
    ['codepress-html', {
      backendUrl: 'https://api.codepress.example.com',
      repositoryId: '123',
      apiToken: 'your-organization-api-key',
      branch: 'main',
      environment: 'production' // Explicitly set environment
    }]
  ]
};
```

The `apiToken` should be an Organization API Key created in the CodePress backend with `file_mappings` permission. This allows CI/CD systems to update file mappings without needing user credentials.

### Auto-detection Features

The plugin includes convenient auto-detection features to minimize configuration:

1. **Git Branch**: The plugin automatically detects the current git branch if the `branch` option is not specified. It uses `git rev-parse --abbrev-ref HEAD` to get the current branch name. If git is not available or the command fails, it will fall back to using `main` as the default branch.

2. **Repository ID**: The plugin automatically extracts the repository ID from your git remote URL if the `repositoryId` option is not specified. It parses the GitHub URL (both HTTPS and SSH formats are supported) to extract the owner and repository name in the format `owner/repo`. This works with URLs like:
   - `https://github.com/owner/repo.git`
   - `git@github.com:owner/repo.git`

These auto-detection features allow you to enable backend sync with minimal configuration:

```javascript
module.exports = {
  plugins: [
    ['codepress-html', {
      apiToken: 'your-organization-api-key'
      // branch, repositoryId, and environment will be auto-detected
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

### Database Storage

The plugin will:

1. Collect file mappings throughout the build process
2. Save all file mappings to the CodePress database in a single bulk request
3. Make a POST request to `{backendUrl}/api/bulk-file-mappings` with all mappings at once
4. Include repository ID, branch, environment, and API key in the request
5. In development mode only, write to a local file as fallback if database save fails
6. Log detailed results including created and updated counts

This efficient batching approach minimizes API requests and improves build performance, especially for large projects with many files. The CodePress browser extension can then correlate DOM elements with source files when editing websites, without needing direct access to the source code.

#### How to Set Up Database Connection

1. In the CodePress backend, go to your GitHub organization settings
2. Navigate to the API Keys section
3. Create a new API key with `file_mappings` permission
4. Note the API key value (it will only be shown once)
5. Configure your build process with the API key:
   - Set `CODEPRESS_API_TOKEN` environment variable, or
   - Add the API key to your babel config
6. Set your environment:
   - For production: Set NODE_ENV=production or specify environment:'production' in options
   - For development: The default is 'development' if not specified

This allows your build system to automatically update file mappings with environment context whenever your code is built, keeping the CodePress database in sync with the latest file locations for both development and production environments.

## License

MIT
