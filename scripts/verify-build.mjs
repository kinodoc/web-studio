import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const dist = resolve('dist');
const htmlPath = join(dist, 'index.html');
const errors = [];
const warnings = [];

if (!existsSync(htmlPath)) {
  console.error('FAIL: dist/index.html не найден. Сначала выполните npm run build.');
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');
const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
const idSet = new Set();
for (const id of ids) {
  if (idSet.has(id)) errors.push(`Повторяющийся id: #${id}`);
  idSet.add(id);
}

for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)) {
  const href = match[1].trim();
  if (href.startsWith('#') && href.length > 1) {
    const fragment = decodeURIComponent(href.slice(1));
    if (!idSet.has(fragment)) errors.push(`Ссылка на отсутствующий раздел: ${href}`);
  }
}

const base = '/web-studio';
for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
  const raw = match[1].trim();
  if (!raw || raw.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue;

  let pathname;
  try {
    pathname = new URL(raw, 'https://local.invalid').pathname;
  } catch {
    errors.push(`Некорректный URL в атрибуте href/src: ${raw}`);
    continue;
  }
  if (pathname.startsWith(base + '/')) pathname = pathname.slice(base.length);
  else if (pathname === base) pathname = '/';

  const target = resolve(dist, '.' + decodeURIComponent(pathname));
  if (!target.startsWith(dist + '/') && target !== dist) {
    errors.push(`Путь выходит за пределы dist: ${raw}`);
    continue;
  }
  const candidate = existsSync(target) && statSync(target).isDirectory()
    ? join(target, 'index.html')
    : target;
  if (!existsSync(candidate)) errors.push(`Локальный ресурс не найден: ${raw} (ожидался ${candidate.slice(dist.length)})`);
}

const required = [
  ['русский язык документа', /<html\b[^>]*\blang=["']ru["']/i],
  ['заголовок страницы', /<title>[^<]+<\/title>/i],
  ['meta description', /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["'][^"']+["']/i],
  ['canonical URL', /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']https?:\/\/[^"']+["']/i],
  ['Open Graph title', /<meta\b[^>]*\bproperty=["']og:title["']/i],
];
for (const [label, pattern] of required) {
  if (!pattern.test(html)) errors.push(`Не найден обязательный SEO/HTML элемент: ${label}`);
}

if (html.includes('hello@example.com')) warnings.push('В сборке остался временный контакт hello@example.com — заменить до публикации.');
if (html.includes('kinodoc.github.io/web-studio')) warnings.push('SEO-адрес всё ещё указывает на GitHub Pages — сверить с реальным URL перед публикацией.');

if (warnings.length) {
  for (const warning of warnings) console.warn('WARNING: ' + warning);
}
if (errors.length) {
  for (const error of errors) console.error('FAIL: ' + error);
  console.error(`Проверка сборки провалена: ${errors.length} ошибка(ок).`);
  process.exit(1);
}
console.log(`OK: HTML, ${ids.length} ID, внутренние якоря, локальные ресурсы и базовые SEO-поля проверены.`);
