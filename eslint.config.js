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
      // Regen and dormancy read `health.lastHurtTick`. A site that takes hp by
      // hand skips it, as the damage-over-time tick did (#130). Each selector
      // matches both `x.hp` and `x['hp']`.
      'no-restricted-syntax': ['error', ...[
        "AssignmentExpression[operator='-='] > MemberExpression.left:matches([property.name='hp'], [property.value='hp'])",
        "AssignmentExpression[operator='+='][right.operator='-'] > MemberExpression.left:matches([property.name='hp'], [property.value='hp'])",
        "AssignmentExpression[operator='=']:matches([left.property.name='hp'], [left.property.value='hp']) > BinaryExpression.right[operator='-']",
        "AssignmentExpression[operator='=']:matches([left.property.name='hp'], [left.property.value='hp']) > CallExpression.right BinaryExpression[operator='-']",
        "UpdateExpression[operator='--'] > MemberExpression.argument:matches([property.name='hp'], [property.value='hp'])",
        "CallExpression[callee.object.name='Object'][callee.property.name='assign'] Property:matches([key.name='hp'], [key.value='hp']) > BinaryExpression.value[operator='-']",
      ].map((selector) => ({ selector, message: 'Take hp with combat.hurt(), which records the hurt.' }))],
    },
  },
  {
    // #15: joining used to build its own BroadcastChannel here as a silent
    // fallback, which reaches no phone. Every join transport comes from
    // openJoinTransport (src/app/openJoinTransport.ts), where it is tested.
    // src/game is left out: a later no-restricted-syntax replaces an earlier
    // one, which would switch off the sim's hp rule above.
    files: ['src/**/*.ts'],
    ignores: ['src/game/**', 'src/app/openJoinTransport.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "NewExpression[callee.name='BroadcastChannelTransport'][arguments.0.value='client']",
        message: 'Open join transports with openJoinTransport (src/app/openJoinTransport.ts), never a BroadcastChannel directly.',
      }],
    },
  },
)
