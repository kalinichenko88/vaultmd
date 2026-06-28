import { defineConfig } from 'vitepress';

import typedocSidebar from '../api/typedoc-sidebar.json';

export default defineConfig({
  base: '/vaultmd/',
  title: 'vaultmd',
  description:
    'Headless markdown-vault data layer for Bun — CRUD + SQLite index.',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'API', link: '/api/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Quick start', link: '/guide/quick-start' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Recipes', link: '/guide/recipes' },
          ],
        },
      ],
      '/api/': [{ text: 'API Reference', items: typedocSidebar }],
    },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/kalinichenko88/vaultmd' },
    ],
  },
});
