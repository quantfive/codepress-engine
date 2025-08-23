module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  overrides: [
    {
      files: ["*.ts", "*.tsx"],
      parser: "@typescript-eslint/parser",
      plugins: ["@typescript-eslint"],
      extends: [
        "eslint:recommended",
        "@typescript-eslint/recommended",
      ],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
      rules: {
        // TypeScript-specific rules
        "@typescript-eslint/no-unused-vars": [
          "warn",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/explicit-function-return-type": "off",
        "@typescript-eslint/no-explicit-any": "warn",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        
        // Disable base rules that are covered by TypeScript equivalents
        "no-unused-vars": "off",
        "no-undef": "off", // TypeScript handles this
      },
    },
  ],
  rules: {
    // Code style
    indent: ["error", 2],
    quotes: ["error", "double"],
    semi: ["error", "always"],
    "comma-trailing": "off", // Allow trailing commas

    // Best practices
    "no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    "no-console": "off", // Allow console.log for CLI tool
    "no-undef": "error",
    eqeqeq: "error",
    curly: "error",

    // Node.js specific
    "no-process-exit": "warn",
    "handle-callback-err": "error",

    // Async/await
    "no-return-await": "error",
    "require-await": "warn",

    // Security
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
  },
  ignorePatterns: [
    "node_modules/",
    "dist/",
    "swc/",
    "codepress-swc-plugin/target/",
    "*.wasm",
  ],
};
