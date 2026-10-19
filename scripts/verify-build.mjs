import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
    let fragment;
    try {
      fragment = decodeURIComponent(href.slice(1));
    } catch {
      errors.push(`Некорректный якорь: ${href}`);
      continue;
    }
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

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    errors.push(`Некорректное кодирование пути: ${raw}`);
    continue;
  }
  const target = resolve(dist, '.' + decodedPath);
  if (!target.startsWith(dist + '/') && target !== dist) {
    errors.push(`Путь выходит за пределы dist: ${raw}`);
    continue;
  }
  const candidate = existsSync(target) && statSync(target).isDirectory()
    ? join(target, 'index.html')
    : target;
  if (!existsSync(candidate)) errors.push(`Локальный ресурс не найден: ${raw} (ожидался ${candidate.slice(dist.length)})`);
}

const h1Count = [...html.matchAll(/<h1\b[^>]*>/gi)].length;
if (h1Count !== 1) errors.push(`На странице должен быть ровно один h1; найдено: ${h1Count}`);

let previousHeadingLevel = 0;
for (const match of html.matchAll(/<h([1-6])\b[^>]*>/gi)) {
  const level = Number(match[1]);
  if (previousHeadingLevel && level > previousHeadingLevel + 1) {
    errors.push(`Нарушена последовательность заголовков: h${previousHeadingLevel} → h${level}`);
  }
  previousHeadingLevel = level;
}

const viewport = /<meta\b(?=[^>]*\bname=["']viewport["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i;
if (!viewport.test(html)) errors.push('Не найден meta viewport с содержимым.');

const accessibilityChecks = [
  ['кнопка мобильного меню с aria-expanded', /<button\b[^>]*aria-expanded=["'](?:true|false)["'][^>]*>/i],
  ['раскрываемые FAQ через нативный details', /<details\b[^>]*>[\s\S]*?<summary\b/i],
  ['основная навигация', /<nav\b[^>]*id=["']site-navigation["']/i],
];
for (const [label, pattern] of accessibilityChecks) {
  if (!pattern.test(html)) errors.push('Не найдена обязательная функция доступности: ' + label);
}

const menuButton = html.match(/<button\b[^>]*data-menu-toggle[^>]*>/i)?.[0] ?? '';
const controlledId = menuButton.match(/\baria-controls=["']([^"']+)["']/i)?.[1];
if (!controlledId) {
  errors.push('Кнопка мобильного меню не указывает управляемый элемент через aria-controls.');
} else {
  const navTags = [...html.matchAll(/<nav\b[^>]*>/gi)].map((match) => match[0]);
  const controlledNavExists = navTags.some((tag) => tag.match(/\bid=["']([^"']+)["']/i)?.[1] === controlledId);
  if (!controlledNavExists) errors.push('aria-controls кнопки мобильного меню указывает на отсутствующую навигацию: ' + controlledId);
}

const layoutPath = resolve('src/layouts/BaseLayout.astro');
if (!existsSync(layoutPath)) {
  errors.push('Исходный layout не найден: src/layouts/BaseLayout.astro.');
} else {
  const layoutSource = readFileSync(layoutPath, 'utf8');
  const menuBehaviorChecks = [
    ['обработка клавиши Escape для закрытия меню', /event\.key\s*===\s*['"]Escape['"]/],
    ['возврат фокуса на кнопку после Escape', /toggle\?\.\s*focus\(\)/],
    ['закрытие меню после выбора ссылки', /querySelectorAll\(['"]a['"]\)[\s\S]*?addEventListener\(['"]click['"],\s*closeMenu\)/],
    ['доступное состояние кнопки через aria-expanded', /setAttribute\(['"]aria-expanded['"],\s*String\(!opened\)\)/],
    ['fallback для браузера без IntersectionObserver', /else\s*{[\s\S]*?querySelectorAll\(['"]\[data-reveal\]['"]\)[\s\S]*?is-visible/],
  ];
  for (const [label, pattern] of menuBehaviorChecks) {
    if (!pattern.test(layoutSource)) errors.push('Не найдена проверка поведения интерфейса: ' + label + '.');
  }
}

const assetsDir = join(dist, '_astro');
if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
  errors.push('Не найдена папка со скомпилированными ресурсами Astro: dist/_astro.');
} else {
  const cssFiles = readdirSync(assetsDir).filter((file) => file.endsWith('.css'));
  if (!cssFiles.length) errors.push('В сборке не найден CSS-файл.');
  const css = cssFiles.map((file) => readFileSync(join(assetsDir, file), 'utf8')).join('\n');
  const cssChecks = [
    ['адаптация для узких экранов (брейкпоинт 640px)', /640px/i],
    ['видимый фокус клавиатуры', /:focus-visible/i],
    ['режим уменьшения анимации', /prefers-reduced-motion\s*:\s*reduce/i],
    ['состояние открытого мобильного меню', /nav\.is-open/i],
  ];
  for (const [label, pattern] of cssChecks) {
    if (!pattern.test(css)) errors.push('В собранном CSS отсутствует ' + label + '.');
  }
}

const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
for (const tag of imageTags) {
  if (!/\balt\s*=\s*["'][^"']*["']/i.test(tag)) errors.push(`У изображения отсутствует alt: ${tag.slice(0, 100)}`);
}

const buttonTags = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)].map((m) => m[0]);
for (const tag of buttonTags) {
  const hasLabel = /\baria-label\s*=\s*["'][^"']+["']/i.test(tag)
    || /\baria-labelledby\s*=\s*["'][^"']+["']/i.test(tag)
    || /<button\b[^>]*>\s*(?:<[^>]+>\s*)*[^\s<][\s\S]*?<\/button>/i.test(tag);
  if (!hasLabel) errors.push(`У кнопки отсутствует доступное имя: ${tag.slice(0, 120)}`);
}

const anchorTags = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((m) => m[0]);
for (const tag of anchorTags) {
  const hasLabel = /\baria-label\s*=\s*["'][^"']+["']/i.test(tag)
    || /\baria-labelledby\s*=\s*["'][^"']+["']/i.test(tag)
    || /<a\b[^>]*>\s*(?:<[^>]+>\s*)*[^\s<][\s\S]*?<\/a>/i.test(tag);
  if (!hasLabel) errors.push(`У ссылки отсутствует доступное имя: ${tag.slice(0, 120)}`);
  if (/\btarget\s*=\s*["']_blank["']/i.test(tag)
      && !/\brel\s*=\s*["'][^"']*\b(?:noopener|noreferrer)\b[^"']*["']/i.test(tag)) {
    errors.push(`Ссылка target="_blank" должна содержать rel="noopener" или rel="noreferrer": ${tag.slice(0, 120)}`);
  }
}

const required = [
  ['русский язык документа', /<html\b[^>]*\blang=["']ru["']/i],
  ['основная область содержимого', /<main\b[^>]*\bid=["']top["']/i],
  ['ссылка быстрого перехода к содержимому', /<a\b[^>]*class=["']skip-link["'][^>]*href=["']#top["']/i],
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


// Audit every generated page, not only the homepage. This catches broken links,
// missing metadata, duplicate IDs, and heading issues on service/contact pages too.
function collectHtmlFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectHtmlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(fullPath);
  }
  return files;
}

for (const pagePath of collectHtmlFiles(dist)) {
  if (pagePath === htmlPath) continue; // The homepage has the detailed checks above.
  const pageHtml = readFileSync(pagePath, 'utf8');
  const relativePage = pagePath.slice(dist.length + 1);
  const pageIds = [...pageHtml.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const pageIdSet = new Set();
  for (const id of pageIds) {
    if (pageIdSet.has(id)) errors.push(`${relativePage}: повторяющийся id: #${id}`);
    pageIdSet.add(id);
  }

  const pageH1Count = [...pageHtml.matchAll(/<h1\b[^>]*>/gi)].length;
  if (pageH1Count !== 1) errors.push(`${relativePage}: должен быть ровно один h1; найдено: ${pageH1Count}`);
  if (!/<html\b[^>]*\blang=["']ru["']/i.test(pageHtml)) errors.push(`${relativePage}: не указан lang="ru".`);
  if (!/<title>[^<]+<\/title>/i.test(pageHtml)) errors.push(`${relativePage}: отсутствует title.`);
  if (!/<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["'][^"']+["']/i.test(pageHtml)) errors.push(`${relativePage}: отсутствует meta description.`);
  if (!/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']https?:\/\/[^"']+["']/i.test(pageHtml)) errors.push(`${relativePage}: отсутствует canonical URL.`);

  if (!/<meta\b(?=[^>]*\bname=["']viewport["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i.test(pageHtml)) errors.push(relativePage + ': отсутствует корректный meta viewport.');
  if (!/<main\b[^>]*\bid=["']top["']/i.test(pageHtml)) errors.push(relativePage + ': отсутствует основная область main#top.');
  if (!/<a\b[^>]*class=["']skip-link["'][^>]*href=["']#top["']/i.test(pageHtml)) errors.push(relativePage + ': отсутствует ссылка быстрого перехода к содержимому.');
  if (!/<meta\b[^>]*\bproperty=["']og:title["']/i.test(pageHtml)) errors.push(relativePage + ': отсутствует Open Graph title.');

  for (const tag of pageHtml.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt=["'][^"']*["']/i.test(tag[0])) errors.push(relativePage + ': у изображения отсутствует alt: ' + tag[0].slice(0, 100));
  }
  for (const tag of pageHtml.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    if (/\btarget=["']_blank["']/i.test(tag[0]) && !/\brel=["'][^"']*\b(?:noopener|noreferrer)\b[^"']*["']/i.test(tag[0])) {
      errors.push(relativePage + ': ссылка target="_blank" должна иметь rel="noopener" или rel="noreferrer".');
    }
  }

  for (const match of pageHtml.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)) {
    const href = match[1].trim();
    if (href.startsWith('#') && href.length > 1) {
      let fragment;
      try {
        fragment = decodeURIComponent(href.slice(1));
      } catch {
        errors.push(`${relativePage}: некорректный якорь: ${href}`);
        continue;
      }
      if (!pageIdSet.has(fragment)) errors.push(`${relativePage}: ссылка на отсутствующий раздел: ${href}`);
    }
  }

  for (const match of pageHtml.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue;
    let pathname;
    try {
      pathname = new URL(raw, 'https://local.invalid').pathname;
    } catch {
      errors.push(`${relativePage}: некорректный URL: ${raw}`);
      continue;
    }
    if (pathname.startsWith(base + '/')) pathname = pathname.slice(base.length);
    else if (pathname === base) pathname = '/';
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      errors.push(`${relativePage}: некорректное кодирование пути: ${raw}`);
      continue;
    }
    const target = resolve(dist, '.' + decodedPath);
    if (!target.startsWith(dist + '/') && target !== dist) {
      errors.push(`${relativePage}: путь выходит за пределы dist: ${raw}`);
      continue;
    }
    const candidate = existsSync(target) && statSync(target).isDirectory()
      ? join(target, 'index.html')
      : target;
    if (!existsSync(candidate)) errors.push(`${relativePage}: локальный ресурс не найден: ${raw}`);
  }
}

if (warnings.length) {
  for (const warning of warnings) console.warn('WARNING: ' + warning);
}
if (errors.length) {
  for (const error of errors) console.error('FAIL: ' + error);
  console.error(`Проверка сборки провалена: ${errors.length} ошибка(ок).`);
  process.exit(1);
}
console.log(`OK: HTML, ${ids.length} ID, ${h1Count} h1, ${anchorTags.length} ссылок, доступные имена, внутренние якоря, локальные ресурсы и базовые SEO-поля проверены.`);
