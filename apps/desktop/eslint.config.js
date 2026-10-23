import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "dist-electron", "dist-web", "release", "coverage", "node_modules", "e2e/screenshots"] },
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
      // New in eslint-plugin-react-hooks 7 (React Compiler checks). The few
      // places they flag work today; warn until they're reworked on their own.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
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
      "no-useless-assignment": "warn",
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
