import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://kinodoc.github.io',
  base: '/web-studio',
  trailingSlash: 'always',
  integrations: [sitemap()],
  build: { format: 'directory' }
});