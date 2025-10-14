# Local Testing Guide for @codepress/codepress-engine

## Method 1: Using npm link (Recommended)

1. **In the codepress-engine directory:**

```bash
npm link
```

2. **In your Next.js project directory:**

```bash
npm link @codepress/codepress-engine
```

3. **Configure your `next.config.js`:**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    swcPlugins: [
      // Use the SWC plugin
      [
        "@codepress/codepress-engine/swc",
        {
          // Optional configuration
          attributeName: "codepress-data-fp",
          repoAttributeName: "codepress-github-repo-name",
          branchAttributeName: "codepress-github-branch",
        },
      ],
    ],
  },
  // Enable SWC minification (optional but recommended)
  swcMinify: true,
};

module.exports = nextConfig;
```

4. **Create a test React component in your app:**

```jsx
// pages/test-codepress.jsx or app/test-codepress/page.jsx
import React from "react";

export default function TestCodePress() {
  return (
    <div className="container">
      <h1>CodePress SWC Plugin Test</h1>
      <div className="content">
        <p>This should have codepress attributes!</p>
        <button onClick={() => alert("Clicked!")}>Click me</button>
      </div>
    </div>
  );
}
```

5. **Run your Next.js app:**

```bash
npm run dev
```

6. **Inspect the HTML in browser dev tools** - you should see attributes like:

```html
<div
  codepress-data-fp="[encoded-path]:[line-numbers]"
  codepress-github-repo-name="[your-repo]"
  codepress-github-branch="[your-branch]"
></div>
```

## Method 2: Using Local File Path

1. **In your Next.js project's `package.json`:**

```json
{
  "dependencies": {
    "@codepress/codepress-engine": "file:../path/to/codepress-engine"
  }
}
```

2. **Install dependencies:**

```bash
npm install
```

3. **Use the same `next.config.js` configuration as Method 1**

## Method 3: Testing Both Babel and SWC

You can also test the Babel version in the same project:

1. **Install as dev dependency:**

```bash
npm install --save-dev @codepress/codepress-engine
```

2. **Create a `babel.config.js`:**

```javascript
module.exports = {
  presets: ["next/babel"],
  plugins: [
    // Use the Babel plugin
    [
      "@codepress/codepress-engine/babel",
      {
        attributeName: "codepress-data-fp",
        repoAttributeName: "codepress-github-repo-name",
        branchAttributeName: "codepress-github-branch",
      },
    ],
  ],
};
```

3. **Disable SWC in `next.config.js` to use Babel:**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable SWC to use Babel
  swcMinify: false,
  experimental: {
    // Remove swcPlugins to use Babel instead
    // swcPlugins: [...]
  },
};

module.exports = nextConfig;
```

## Debugging Tips

### 1. Check Console Output

Look for these messages in your terminal when running `npm run dev`:

- `✓ Detected GitHub repository: [repo-name]`
- `✓ Adding repo attribute globally to <element>`

### 2. Verify Plugin Loading

In your browser's Network tab, check that the WASM file loads:

- Look for `codepress_engine.wasm` in network requests

### 3. Inspect Generated HTML

In browser dev tools, look for these attributes on JSX elements:

- `codepress-data-fp="[base64-encoded-path]:[start-line]-[end-line]"`
- `codepress-github-repo-name="[repo-name]"`
- `codepress-github-branch="[branch-name]"`

### 4. Test Different Scenarios

- Different file paths
- Different JSX elements (div, button, etc.)
- Nested components
- Multiple components in same file

## Cleanup After Testing

When done testing, unlink the package:

```bash
# In your Next.js project
npm unlink @codepress/codepress-engine

# In the codepress-engine directory
npm unlink
```

## Troubleshooting

### WASM Plugin Not Loading

- Ensure `swc/codepress_engine.wasm` exists and is not empty
- Check that Next.js version supports SWC plugins (13.2.4+)
- Verify the file path in `next.config.js` matches the actual export

### No Attributes Appearing

- Check browser console for errors
- Verify you're in a git repository
- Make sure JSX elements are being transformed (not just plain HTML)
- Check that the component is actually being rendered

### Git Info Not Detected

- Ensure you're in a git repository with a remote origin
- Check that `git config --get remote.origin.url` returns a valid GitHub URL
- Branch detection requires `git rev-parse --abbrev-ref HEAD` to work
