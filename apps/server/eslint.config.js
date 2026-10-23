import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // New in ESLint 10: stricter style checks that flag code written before the
      // upgrade (mostly community plugins). Warn until each is cleaned up.
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "no-undef": "off",
    },
  },
);
