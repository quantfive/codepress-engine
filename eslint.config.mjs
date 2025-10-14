// Flat ESLint config for a TypeScript Node library with Jest and Prettier
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import jsdocPlugin from "eslint-plugin-jsdoc";
import nodePlugin from "eslint-plugin-node";
import promisePlugin from "eslint-plugin-promise";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "swc/**",
      "codepress-swc-plugin/target/**",
      "**/*.d.ts",
      "eslint.config.mjs",
    ],
  },
  {
    files: ["**/*.{js,jsx}"],
    extends: [js.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
    },
    plugins: {
      import: importPlugin,
      node: nodePlugin,
      promise: promisePlugin,
      jsdoc: jsdocPlugin,
    },
    rules: {
      // General best practices
      eqeqeq: ["error", "smart"],
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": "off",

      // Import rules
      "import/order": [
        "warn",
        {
          groups: [
            ["builtin", "external"],
            "internal",
            ["parent", "sibling", "index"],
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // Promises
      "promise/always-return": "off",
      "promise/no-nesting": "off",
      "promise/no-return-wrap": "error",

      // Node
      "node/no-unsupported-features/es-syntax": "off",

      // JSDoc
      "jsdoc/check-alignment": "warn",
      "jsdoc/check-indentation": "off",

      // Formatting handled by Prettier CLI; ESLint does not enforce formatting
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      // No project configuration here to avoid type-aware rules initially
    },
    plugins: {
      import: importPlugin,
      node: nodePlugin,
      promise: promisePlugin,
      jsdoc: jsdocPlugin,
    },
    rules: {
      // General best practices
      eqeqeq: ["error", "smart"],
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": "off",

      // Import rules
      "import/order": [
        "warn",
        {
          groups: [
            ["builtin", "external"],
            "internal",
            ["parent", "sibling", "index"],
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // Promises
      "promise/always-return": "off",
      "promise/no-nesting": "off",
      "promise/no-return-wrap": "error",

      // Node
      "node/no-unsupported-features/es-syntax": "off",

      // JSDoc
      "jsdoc/check-alignment": "warn",
      "jsdoc/check-indentation": "off",

      // TypeScript specific
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Formatting handled by Prettier CLI; ESLint does not enforce formatting
    },
  },
  {
    files: ["{test,tests}/**/*.test.ts"],
    extends: [...tseslint.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
