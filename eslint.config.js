import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default defineConfig(
  { ignores: ['dist/'] },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, sonarjs.configs.recommended],
    languageOptions: {
      // Type information lets the sonarjs rules that need it run, as they do on a SonarQube server.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `any` is used on purpose to read untyped JSON (credentials file, unofficial
      // endpoints, transcripts), and every read is guarded by a typeof check.
      // sonarjs's recommended config leaves its `any` rule (no-return-type-any) off too.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
