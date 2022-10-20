const {toEditorSettings} = require('typescript');

module.exports = {
  docs: [
    // TODO clean out the unused docs
    {
      'Get Started': [
        {
          type: 'category',
          label: 'Hello, Replicache',
          link: {
            type: 'doc',
            id: 'hello-replicache',
          },
          items: [
            'app-features',
            'app-structure',
            'first-replicache-feature',
            {
              'Next Steps': [
                'deploy-render',
                'deploy-elsewhere',
                'local-postgres',
              ],
            },
          ],
        },
        'quickstarts',
      ],
    },
    {
      Examples: ['example-todo', 'example-repliear', 'example-replidraw'],
    },
    {
      'Understand Replicache': [
        'how-it-works',
        'performance',
        'offline',
        'consistency',
        'faq', // TODO review
        // TODO what replicache is good for
      ],
    },
    {
      Reference: [
        {
          'JavaScript Reference': [
            {
              type: 'autogenerated',
              dirName: 'api', // 'api' is the 'out' directory
            },
          ],
        },
        'server-push',
        'server-pull',
      ],
    },
    {
      HOWTO: [
        'howto-licensing',
        'howto-blobs',
        'howto-launch',
        'howto-undo',
        {
          // TODO figure out what to do with this
          'Integrate with your own backend': [
            'guide-intro',
            'guide-design-client-view',
            'guide-install-replicache',
            'guide-render-ui',
            'guide-local-mutations',
            'guide-database-setup',
            'guide-remote-mutations',
            'guide-dynamic-pull',
            'guide-poke',
            'guide-conclusion',
          ],
        },
      ],
    },
  ],
};
