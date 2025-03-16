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
      outputPath: 'custom-file-map.json', // default: 'file-hash-map.json'
      attributeName: 'data-fp' // default: 'codepress-data-fp'
    }]
  ]
};
```

## How it works

This plugin:

1. Generates a unique hash for each file processed by Babel
2. Adds a custom attribute to all JSX opening elements with the file's hash
3. Creates a mapping file (file-hash-map.json) that connects hashes to file paths

This allows tools like Codepress to identify which React component file corresponds to rendered HTML elements, enabling visual editing capabilities.

## License

MIT
