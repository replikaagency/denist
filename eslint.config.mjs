import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  // Enforce thin chat orchestrator (see docs/ARCHITECTURE_RULES.md)
  {
    files: ["src/services/chat.service.ts"],
    rules: {
      "max-lines": ["error", { max: 300, skipBlankLines: false, skipComments: false }],
      "max-depth": ["error", 3],
    },
  },
];

export default eslintConfig;
