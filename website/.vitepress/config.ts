import { defineConfig } from 'vitepress';

import typedocSidebar from '../api/typedoc-sidebar.json';

const guideSidebar = [
  {
    text: 'Getting started',
    items: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Quick start', link: '/guide/quick-start' },
    ],
  },
  {
    text: 'Guides',
    items: [
      { text: 'Concepts', link: '/guide/concepts' },
      { text: 'Recipes', link: '/guide/recipes' },
    ],
  },
];

export default defineConfig({
  base: '/',
  title: 'VaultMD',
  description:
    'Headless markdown-vault data layer for Bun — CRUD + SQLite index.',
  themeConfig: {
    nav: [
      {
        text: 'Getting started',
        link: '/guide/introduction',
        activeMatch: '^/guide/(introduction|quick-start)',
      },
      { text: 'Concepts', link: '/guide/concepts' },
      { text: 'Recipes', link: '/guide/recipes' },
      { text: 'API', link: '/api/', activeMatch: '^/api/' },
    ],
    sidebar: {
      '/guide/': guideSidebar,
      '/api/': [
        ...guideSidebar.map((group) => ({ ...group, collapsed: true })),
        { text: 'API Reference', items: typedocSidebar },
      ],
    },
    outline: [2, 3],
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/kalinichenko88/vaultmd' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/vaultmd' },
    ],
    footer: { message: 'Released under the MIT License.' },
  },
});
