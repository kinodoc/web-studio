import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://kinodoc.github.io',
  base: '/web-studio',
  trailingSlash: 'always',
  build: { format: 'directory' }
});