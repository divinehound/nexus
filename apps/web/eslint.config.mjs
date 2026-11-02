import baseConfig from '@nexus/eslint-config/base';

export default [
  ...baseConfig,
  {
    rules: {
      'no-restricted-globals': ['error',
        {
          name: 'alert',
          message: 'Use toast notifications (toast.success/error) instead of window.alert()'
        },
        {
          name: 'confirm',
          message: 'Use confirmDialog() from @/components/ui/dialogs instead of window.confirm()'
        },
        {
          name: 'prompt',
          message: 'Use promptDialog() from @/components/ui/dialogs instead of window.prompt()'
        }
      ],
      // The globals rule misses window.confirm(...) and friends.
      'no-restricted-properties': ['error',
        ...['window', 'globalThis', 'self'].flatMap((object) => [
          { object, property: 'alert', message: 'Use toast notifications (toast.success/error) instead of window.alert()' },
          { object, property: 'confirm', message: 'Use confirmDialog() from @/components/ui/dialogs instead of window.confirm()' },
          { object, property: 'prompt', message: 'Use promptDialog() from @/components/ui/dialogs instead of window.prompt()' },
        ])
      ]
    }
  }
];
