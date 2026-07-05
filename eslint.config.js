import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/game/**/*.ts'],
    ignores: ['src/game/**/*.test.ts'],
    rules: {
      // The sim must stay pure: no rendering, DOM, networking, or wall-clock/random deps.
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/render/**', '**/input/**', '**/ui/**', '**/net/**', 'pixi.js'], message: 'src/game is the pure sim — it must not import render/input/ui/net or pixi.' },
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'Date', message: 'No wall-clock in the sim. Ticks only.' },
      ],
      'no-restricted-properties': ['error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng from rng.ts.' },
        { object: 'Date', property: 'now', message: 'No wall-clock in the sim. Ticks only.' },
      ],
    },
  },
)
