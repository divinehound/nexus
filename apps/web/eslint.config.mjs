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
          message: 'Use ConfirmModal component instead of window.confirm()'
        },
        {
          name: 'prompt',
          message: 'Use InputModal component instead of window.prompt()'
        }
      ]
    }
  }
];
