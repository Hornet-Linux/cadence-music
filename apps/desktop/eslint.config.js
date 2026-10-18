import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "dist-electron", "release", "coverage", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-undef": "off",
    },
  },
  {
    files: ["electron/**/*.ts", "*.config.{js,ts}", "e2e/**/*.mjs", "scripts/**/*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    // electron-builder hooks are loaded with require(), so they stay CommonJS.
    files: ["scripts/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
