import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: ['krita/**', 'status.md'],
  },
  {
    // Ambient declarations describe global objects rather than executing var statements.
    files: ['**/*.d.ts'],
    rules: { 'vars-on-top': 'off' },
  },
  {
    // Browser startup and Node test entry modules intentionally await initialization.
    files: ['web/main.ts', 'tests/test_*.ts'],
    rules: { 'antfu/no-top-level-await': 'off' },
  },
  {
    // This entry forwards native Krita stdout/stderr and records startup warnings.
    files: ['web/main.ts'],
    rules: { 'no-console': 'off' },
  },
)
