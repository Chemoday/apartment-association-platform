import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.aistudio/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Security & enterprise guardrails
      'vue/no-v-html': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // Pragmatic baseline during incremental JS -> TS migration (#050)
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-misleading-character-class': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'prefer-const': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/no-reserved-component-names': 'warn',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    // All shared UI components (base + domain) and layouts must stay 100% strict TypeScript with no explicit `any`
    files: ['src/components/**/*.vue', 'src/layouts/**/*.vue'],
    rules: {
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Core application layers, shared mocks, and utility modules must not use explicit `any`
    files: [
      'src/api/**/*.ts',
      'src/stores/**/*.ts',
      'src/composables/**/*.ts',
      'src/router/**/*.ts',
      'src/mocks/**/*.ts',
      'src/utils/**/*.ts',
      'src/server/**/*.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Domain guardrail: meter/consumption math must use exact BigInt decimal helpers (meterValue.js), never parseFloat
    files: [
      'src/utils/meterValue.{js,ts}',
      'src/utils/consumption.{js,ts}',
      'src/utils/matrixStarts.{js,ts}',
      'src/utils/anomalyFlow.{js,ts}',
      'src/utils/nextSubmission.{js,ts}',
      'src/views/readings/**/*.vue',
      'src/views/accounting/**/*.vue',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Do not use parseFloat for meter readings or consumption math; use exact helpers from src/utils/meterValue.js.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message:
            'Do not use Number.parseFloat for meter readings or consumption math; use exact helpers from src/utils/meterValue.js.',
        },
        {
          object: 'window',
          property: 'parseFloat',
          message:
            'Do not use window.parseFloat for meter readings or consumption math; use exact helpers from src/utils/meterValue.js.',
        },
        {
          object: 'globalThis',
          property: 'parseFloat',
          message:
            'Do not use globalThis.parseFloat for meter readings or consumption math; use exact helpers from src/utils/meterValue.js.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,js}', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-console': 'off',
    },
  },
]
