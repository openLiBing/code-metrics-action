// ESLint 9 flat config（Node.js Action 插件，忽略 ncc 构建产物）
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    // 仅忽略 ncc 打包产物 dist/index.js 本身；dist/ 下其余 .js 均为手写源码模块，必须纳入检查
    ignores: ["node_modules/**", "reports/**", "dist/index.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 递归覆盖 dist/ 下各层源码模块（原 ["*.js"] 只匹配根目录一层，导致 dist 源码 0 覆盖）
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        // ncc 注入的运行时全局：源码以 typeof 探测，仅 bundle 形态下存在
        __nccwpck_require__: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      // 本仓为 CommonJS，require() 是标准写法；该 TS 取向规则不适用，且与基础 no-unused-vars 重复上报
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // 保留 x == null（同时覆盖 null 与 undefined）的惯用写法，其余比较仍强制 ===
      eqeqeq: ["error", "always", { null: "ignore" }],
      // 允许 const crypto = require('crypto') 这类对 Node 内建全局的遮蔽
      "no-redeclare": ["error", { builtinGlobals: false }],
      "no-console": "off",
      "no-undef": "error",
    },
  },
];
