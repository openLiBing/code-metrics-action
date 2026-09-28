// ESLint 9 flat config（Node.js Action 插件，忽略 ncc 构建产物）
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", "reports/**", "dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": "warn",
      eqeqeq: ["error", "always"],
      "no-console": "off",
      "no-undef": "error",
    },
  },
];
