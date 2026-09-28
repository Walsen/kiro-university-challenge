import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "**/cdk.out/**",
      "coverage/**",
      "**/node_modules/**",
      ".devbox/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Config files and build scripts are not part of the typed project graph.
    files: ["*.config.ts", "*.config.js", "scripts/**/*.mjs"],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
    extends: [tseslint.configs.disableTypeChecked],
  },
);
