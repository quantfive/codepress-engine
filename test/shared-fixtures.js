/**
 * Shared test fixtures for both Babel and SWC plugins
 * Ensures feature parity by testing the same inputs
 */

export const fixtures = [
  {
    name: 'basic-jsx-element',
    input: '<div>Hello</div>',
    expectedAttributes: ['codepress-data-fp'],
    description: 'Should add file path attribute',
  },
  {
    name: 'custom-component',
    input: '<MyComponent prop={value} />',
    expectedAttributes: [
      'codepress-data-fp',
      // SWC adds these, Babel doesn't (yet)
      'data-codepress-edit-candidates',
      'data-codepress-source-kinds',
    ],
    description: 'Should track custom components',
    onlySwc: true, // Mark features only in SWC
  },
  {
    name: 'repo-branch-injection',
    input: 'export default function App() { return <div>App</div> }',
    expectedGlobals: ['codepress-github-repo-name', 'codepress-github-branch'],
    description: 'Should inject repo/branch info',
  },
];
