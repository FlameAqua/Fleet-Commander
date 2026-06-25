import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Dev-only Fast Refresh hint — co-locating a type/constant with a
      // component is fine here and doesn't affect the build. Keep as a warning.
      'react-refresh/only-export-components': 'warn',
      // React-Compiler-oriented rules (react-hooks 6+) that flag valid patterns
      // we use deliberately (latest-ref assignment in render; setState in a
      // data-fetch effect; Math.random for decorative scenery). Keep visible as
      // warnings rather than blocking CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
])
