import { parseCss, replaceCssUrl } from './css-parser';
import { parseJs } from './js-parser';
import { parseHtml } from './html-parser';
import { resolveUrl } from '../utils';

export function parseComponent(text, source, options = {}) {
  let jsSource = '';
  let cssText = '';
  const metas = [];
  const jsRefs = [];

  const html = text
    .replace(/<script(.*?)>([\w\W]*?)<\/script>\n?/gmi, (_, attrs, sourceCode) => {
      // 获取meta信息
      if (/ type=['"]application\/(ld\+)?json['"]/.test(attrs)) {
        metas.push(JSON.parse(sourceCode));
        return '';
      }

      // 获取直接 <script src> 的脚本
      if (/ src=['"].*?['"]/.test(attrs)) {
        const [, src] = attrs.match(/src=['"](.*?)['"]/);
        // type可能不存在
        const [, type] = attrs.match(/type=['"](.*?)['"]/) || [];
        const url = resolveUrl(source, src);
        jsRefs.push({ url, src, type });
        return '';
      }

      jsSource += sourceCode;
      return '';
    })
    .replace(/<style>([\w\W]*?)<\/style>\n?/gmi, (_, sourceCode) => {
      cssText += sourceCode;
      return '';
    })
    .trim();

  const jsContext = jsSource ? parseJs(options.prettyJs ? options.prettyJs(jsSource) : jsSource) : {};
  const { imports, deps, code: jsCode, components, vars } = jsContext;

  const cssContext = cssText ? parseCss(options.prettyCss ? options.prettyCss(cssText) : cssText, source, vars) : {};
  const { code: cssCode, refs: cssRefs } = cssContext;
  const htmlSource = options.prettyHtml ? options.prettyHtml(html) : html;
  const { code: htmlCode } = htmlSource ? parseHtml(htmlSource, components, vars, source) : {};

  return {
    metas,
    imports,
    deps,
    components,
    jsCode,
    cssCode,
    htmlCode,
    cssRefs,
    jsRefs,
  };
}

export function genComponent({ imports = [], deps = [], jsCode, cssCode, htmlCode }, source, options = {}) {
  const output = [
    ...imports.map(([vars, src]) => `import ${vars} from "${resolveUrl(source, src)}";`),
    '\n',
    `SFCJS.define("${source}", [${deps.map(([, src, isComponent]) => `"${isComponent ? resolveUrl(source, src) : src}"`).join(', ')}], async function(${deps.map(([name]) => `${name}`).join(', ')}) {`,
    'const _sfc = this',
    jsCode,
    'return {',
    cssCode ? `dye:${cssCode},` : '',
    `render:${htmlCode || '() => null'}`,
    '}',
    '});',
  ].join('\n');
  const res = options.prettyJs ? options.prettyJs(output) : output;
  return res;
}

export async function loadCssRefs(cssRefs, source) {
  const promises = [];

  if (cssRefs && cssRefs.length) {
    promises.push(...cssRefs.map(async ({ type, url, src }) => {
      const text = await fetch(url).then(res => res.text());
      const code = type === 'text/css' ? replaceCssUrl(text, source) : text;
      return { code, type, url, src };
    }));
  }

  return await Promise.all(promises);
}

export async function compileComponent(source, text, options) {
  const context = parseComponent(text, source, options);
  const cssRefs = await loadCssRefs(context.cssRefs, source);
  const code = genComponent(context, source, options);
  const { metas, jsRefs } = context;
  return { code, cssRefs, metas, jsRefs };
}

export async function loadComponent(source, options) {
  const text = await fetch(source).then(res => res.text());
  const chunk = await compileComponent(source, text, options);
  return chunk;
}
