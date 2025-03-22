const babel = require('@babel/core');
const plugin = require('../src/index');
const fs = require('fs');
const path = require('path');

// Mock fs.writeFileSync
fs.writeFileSync = jest.fn();

// Mock node-fetch
jest.mock('node-fetch', () => jest.fn(() => 
  Promise.resolve({
    ok: true,
    text: () => Promise.resolve('{}')
  })
));

// Mock child_process.execSync for git detection
jest.mock('child_process', () => ({
  execSync: jest.fn((command) => {
    if (command.includes('rev-parse --abbrev-ref HEAD')) {
      return 'test-branch';
    }
    if (command.includes('remote.origin.url')) {
      return 'https://github.com/codepress/test-repo.git';
    }
    return '';
  })
}));

describe('codepress-html-babel-plugin', () => {
  beforeEach(() => {
    // Clear mocks between tests
    jest.clearAllMocks();
  });

  it('adds codepress-data-fp attribute to JSX elements', () => {
    const example = `
      import React from 'react';
      
      function App() {
        return (
          <div>
            <h1>Hello World</h1>
            <p>This is a test</p>
          </div>
        );
      }
    `;

    const { code } = babel.transform(example, {
      filename: 'src/App.js',
      plugins: [plugin],
      presets: ['@babel/preset-react']
    });

    // Verify attributes were added
    expect(code).toContain('codepress-data-fp');
    
    // Check for multiple elements - should have 3 elements with the attribute
    const matches = code.match(/codepress-data-fp/g);
    expect(matches).toHaveLength(3);
  });

  it('respects custom attribute name option', () => {
    const example = `
      function Button() {
        return <button>Click me</button>;
      }
    `;

    const { code } = babel.transform(example, {
      filename: 'src/Button.js',
      plugins: [[plugin, { attributeName: 'data-custom' }]],
      presets: ['@babel/preset-react']
    });

    expect(code).toContain('data-custom');
    expect(code).not.toContain('codepress-data-fp');
  });

  it('writes file mapping to the specified output path', () => {
    const example = '<div></div>';

    babel.transform(example, {
      filename: 'src/Test.js',
      plugins: [[plugin, { outputPath: 'custom-map.json' }]],
      presets: ['@babel/preset-react']
    });

    // Get post hook to run
    const pluginInstance = plugin(babel);
    pluginInstance.post();

    // Verify write was called with correct path
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'custom-map.json',
      expect.any(String)
    );
  });

  it('skips files in node_modules', () => {
    const example = '<div></div>';

    const { code } = babel.transform(example, {
      filename: 'node_modules/some-lib/index.js',
      plugins: [plugin],
      presets: ['@babel/preset-react']
    });

    // Should not add attribute to node_modules files
    expect(code).not.toContain('codepress-data-fp');
  });

  it('enables backend sync when config options are provided', () => {
    const fetch = require('node-fetch');
    const example = '<div></div>';

    babel.transform(example, {
      filename: 'src/Test.js',
      plugins: [[plugin, { 
        syncWithBackend: true,
        repositoryId: '123',
        apiToken: 'test-token', 
        backendUrl: 'https://example.com'
      }]],
      presets: ['@babel/preset-react']
    });

    // Get post hook to run
    const pluginInstance = plugin(babel);
    pluginInstance.post();

    // Wait for promises to resolve
    return new Promise(process.nextTick).then(() => {
      // Verify fetch was called with correct URL and options
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/api/bulk-file-mappings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          })
        })
      );
    });
  });
  
  it('auto-detects git branch when branch option is not provided', () => {
    const fetch = require('node-fetch');
    const { execSync } = require('child_process');
    const example = '<div></div>';

    babel.transform(example, {
      filename: 'src/Test.js',
      plugins: [[plugin, { 
        syncWithBackend: true,
        repositoryId: '123',
        apiToken: 'test-token',
        backendUrl: 'https://example.com'
      }]],
      presets: ['@babel/preset-react']
    });

    // Get post hook to run
    const pluginInstance = plugin(babel);
    pluginInstance.post();

    // Wait for promises to resolve
    return new Promise(process.nextTick).then(() => {
      // Verify execSync was called to get the branch
      expect(execSync).toHaveBeenCalledWith('git rev-parse --abbrev-ref HEAD', expect.any(Object));
      
      // Verify the auto-detected branch ('test-branch' from our mock) was used
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/api/bulk-file-mappings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"branch":"test-branch"')
        })
      );
    });
  });
  
  it('auto-detects git repository ID when repositoryId option is not provided', () => {
    const fetch = require('node-fetch');
    const { execSync } = require('child_process');
    const example = '<div></div>';

    babel.transform(example, {
      filename: 'src/Test.js',
      plugins: [[plugin, { 
        syncWithBackend: true,
        apiToken: 'test-token',
        backendUrl: 'https://example.com'
      }]],
      presets: ['@babel/preset-react']
    });

    // Get post hook to run
    const pluginInstance = plugin(babel);
    pluginInstance.post();

    // Wait for promises to resolve
    return new Promise(process.nextTick).then(() => {
      // Verify execSync was called to get the remote URL
      expect(execSync).toHaveBeenCalledWith('git config --get remote.origin.url', expect.any(Object));
      
      // Verify the auto-detected repository ID ('codepress/test-repo' from our mock) was used
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/api/bulk-file-mappings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"repository_id":"codepress/test-repo"')
        })
      );
    });
  });
});
