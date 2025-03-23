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
      
      // HTML attribute options
      attributeName: 'data-fp', // default: 'codepress-data-fp'
      repoAttributeName: 'codepress-github-repo-name', // default: 'codepress-github-repo-name'
      branchAttributeName: 'codepress-github-branch', // default: 'codepress-github-branch'
      
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
2. Adds file hash attributes to all JSX opening elements:
   - `codepress-data-fp` - Contains the file's unique hash on each element
3. Adds repository information to container elements (html, body, or div):
   - `codepress-github-repo-name` - Contains the repository name (owner/repo)
   - `codepress-github-branch` - Contains the branch name
4. Creates a mapping file (file-hash-map.json) that connects hashes to file paths
5. Optionally syncs the file mappings with a CodePress backend server

The repository and branch information is:
- Added to HTML, body or div elements that will actually appear in the DOM
- Only added once per file to keep the DOM clean and efficient
- Added in plain text format for easy access
- Automatically detected by the browser extension without requiring manual selection

**Note:** In a typical React app, the repo attributes will be added to the first div element
encountered because the html and body elements aren't usually processed by Babel directly.

This allows the CodePress extension to identify which React component file corresponds
to rendered HTML elements, enabling visual editing capabilities with automatic
repository detection.

### Browser Extension Integration

The plugin includes a utility module for extracting repository and branch information from DOM elements:

```javascript
// In your browser extension
const { extractRepositoryInfo } = require('babel-plugin-codepress-html/dist/hash-util');

// Automatically detect repository info from the DOM
function detectRepositoryInfo() {
  // Check root elements first (html, body, head)
  const rootElements = [
    document.documentElement, // html
    document.body,
    document.head
  ];
  
  // Look for repo attributes in root elements first
  for (const element of rootElements) {
    if (!element) continue;
    
    if (element.hasAttribute('codepress-github-repo-name')) {
      const repository = element.getAttribute('codepress-github-repo-name');
      const branch = element.getAttribute('codepress-github-branch') || 'main';
      
      return { repository, branch };
    }
  }
  
  // Fallback: Look for any elements with repo attributes
  const element = document.querySelector('[codepress-github-repo-name]');
  if (!element) return null;
  
  const repository = element.getAttribute('codepress-github-repo-name');
  const branch = element.getAttribute('codepress-github-branch') || 'main';
  
  return { repository, branch };
}

// Use the repository info in your extension
const repoInfo = detectRepositoryInfo();
if (repoInfo) {
  console.log(`Repository: ${repoInfo.repository}, Branch: ${repoInfo.branch}`);
  // Use this information instead of asking the user to manually select a repository
}
```

This automatic detection enables a seamless experience where the browser extension immediately 
knows which repository and branch the page is built from, eliminating the need for users to 
manually select anything.

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

## Changelog

### Version 0.5.0
- Removed hashing from repository and branch attributes for simpler integration
- Added restriction to only apply repository attributes to container elements (html, body, div)
- Simplified repository detection in the browser extension
- Added support for automatic organization ID generation in the browser extension

### Version 0.4.3
- Added hashing for repository and branch information
- Improved repository and branch auto-detection
- Added bulk API request for file mappings

## License

MIT