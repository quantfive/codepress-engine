const babel = require('@babel/core');
const plugin = require('../src/index');
const fs = require('fs');
const path = require('path');

// Mock fs.writeFileSync
fs.writeFileSync = jest.fn();

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
});
