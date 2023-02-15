import { parseComponent, genComponent } from '../compiler';
import { replaceCssUrl } from '../compiler/css-parser';
import { name } from '../../package.json';
import path from 'path';
import fs from 'fs';
import { resolveUrl } from '../utils';
import { createRandomString, getStringHash, num10to62, createSafeExp } from 'ts-fns';

export function bundle(file, options = {}) {
  const contents = [];
  const importSources = {};
  const compileOptions = {};
  const stylesSet = {};

  // entryUrl 入口的url地址，这是由框架决定的，需要用这个来确定组件的引用
  // absRootPath 由于有些组件直接使用绝对路径 / 开头，因此，我们需要提供 absRootPath 作为所谓 / 的读取位置，一般是项目所在目录
  const {
    baseUrlExp = '',
    entryUrl = `/${path.basename(file)}`,
    absRootPath = path.dirname(file),
    outputDir = absRootPath,
    importLib = false,
    ignores = [],
    alias = {},
    exportUrl = false,
    macro = false,
  } = options;

  const pushDeclare = (declares, str, hash, importDirectly = false) => {
    if (!str) {
      return;
    }

    const [origin, asVar] = str.split(' as ').map(item => item.trim());
    const newVar = `${origin}$${hash}`;
    const hasAs = !!asVar;
    const importDefault = !hasAs && importDirectly;

    // import App from './app' => import { default as App$xxx } from './app'
    // import * as Utils from './utils' => import * as Utils$xxx from './utils'
    // import React, { useState as useReactState, useMemo } from 'react'
    // => import { default as React$xxx, useState as useReactState$xxx, useMemo as useMemo$xxx } from 'react'
    const declareItem = {
      hasAs,
      default: importDefault,
      export: origin, // 模块的export名
      scopeAs: hasAs ? asVar : origin, // 在当前文件中的变量名
      var: newVar, // 变更后的变量名
      str: importDefault ? `default as ${newVar}` : `${origin} as ${newVar}`,
    };
    declares.push(declareItem);
  };

  function compile(file, url) {
    const resolveImportFile = (src) => {
      const newPath = src.indexOf('/') === 0 ? path.resolve(outputDir, `.${src}`) : path.resolve(path.dirname(file), src);
      return newPath;
    };
    const relativeImportFile = (src) => {
      const newPath = resolveImportFile(src);
      const relPath = path.relative(outputDir, newPath);
      const finalPath = relPath.indexOf('.') === 0 ? relPath : `./${relPath}`;
      return finalPath;
    };
    const fileContent = fs.readFileSync(file).toString();

    const isIgnored = file => ignores.length && ignores.some((ignore) => {
      if (ignore instanceof RegExp && ignore.test(file)) {
        return true;
      }
      if (typeof ignore === 'string' && ignore === file) {
        return true;
      }
      return false;
    });

    const context = parseComponent(fileContent, url, compileOptions);
    const { components = {}, imports = [], cssRefs, metas, ...info } = context;

    const importSet = {};
    imports.forEach(([importDeclare, importSrc]) => {
      const src = relativeImportFile(importSrc);
      const declares = [];
      const hash = num10to62(getStringHash(src));

      if (importDeclare.indexOf('{') > -1 && importDeclare.indexOf('}') > -1) {
        const [asOut, asExports] = importDeclare.split('{');

        const outs = asOut.trim().split(',')
          .map(item => item.trim())
          .filter(item => item);
        if (outs.length) {
          outs.forEach((item) => {
            pushDeclare(declares, item, hash, true);
          });
        }

        const exportItems = asExports.replace('}', '').split(',')
          .map(item => item.trim())
          .filter(item => item);
        if (exportItems.length) {
          exportItems.forEach((item) => {
            pushDeclare(declares, item, hash);
          });
        }
      }

      importSet[src] = importSet[src] || {};
      importSources[src] = importSources[src] || {};
      declares.forEach((item) => {
        // item.scopeAs 在一个文件中一定是唯一的
        importSet[src][item.scopeAs] = item;
        // item.export 在整个构建包中是唯一的，但是同一个export可能被as为多个不同的scopeAs
        importSources[src][item.export] = importSources[src][item.export] || [];
        importSources[src][item.export] = item.str;
      });
    });

    const scopeVars = [];
    const newVars = [];
    Object.keys(importSet).forEach((src) => {
      Object.keys(importSet[src]).forEach((scopeAs) => {
        const item = importSet[src][scopeAs];
        scopeVars.push(item.scopeAs);
        newVars.push(item.var);
      });
    });

    // 被忽略的文件不被写入最终的bundle，但是它所引入的子组件还需要继续编译
    if (!isIgnored(file)) {
      let fileCode = genComponent(info, url, compileOptions);

      if (cssRefs && cssRefs.length) {
        const relativeTo = url;
        cssRefs.forEach(({ url, type, src }) => {
          if (type === 'text/css' && !stylesSet[url]) {
            let id = '';
            // TODO 假如 url 对应 file 和之前不一致怎么办？虽然是不应该发生的
            if (!stylesSet[url]) {
              const file = resolveImportFile(src);
              const text = fs.readFileSync(file).toString();
              const css = replaceCssUrl(text, relativeTo);
              id = createRandomString(8);
              stylesSet[url] = { id, css, type };
            } else {
              id = stylesSet[url].id;
            }
            fileCode = fileCode.replace(new RegExp(`['"]sfc:${createSafeExp(src)}['"]`, 'gmi'), `CSS["${id}"]`);
          }
        });
      }

      // 处理宏
      if (macro && metas && metas.length) {
        metas.forEach((meta) => {
          if (meta?.['@context'] === 'sfc:privilege') {
            const tag = meta['@type'];
            const { props, events } = meta;
            const html = `\nSFCJS.privilege('${tag}',${JSON.stringify({ props, events, src: url })});`;
            fileCode += `\n${html}`;
          }
        });
      }

      const newFileContent = `/* ${url} */\n;(function(${scopeVars.join(',')}) {\n${fileCode}\n} (${newVars.join(',')}));`;
      contents.push(newFileContent);
    } else {
      contents.push(`/* ignored ${url} */`);
    }

    const componentUrls = Object.values(components);
    componentUrls.forEach((componentUrl) => {
      const componentPath = alias[componentUrl] || componentUrl;
      const relativeUrl = resolveUrl(url, componentPath);
      const relativePath = componentPath.indexOf('/') === 0 ? path.resolve(absRootPath, `.${componentPath}`) : path.resolve(path.dirname(file), componentPath);
      compile(relativePath, relativeUrl);
    });
  }

  compile(file, entryUrl);

  const importLines = [];
  Object.keys(importSources).forEach((src) => {
    const declareItems = Object.values(importSources[src]);
    if (declareItems.length) {
      importLines.push(`import { ${declareItems.join(', ')} } from '${src}';`);
    } else {
      importLines.push(`import '${src}';`);
    }
  });

  const cssFiles = Object.keys(stylesSet).map((url) => {
    const { id, css, type } = stylesSet[url];
    // 异步生成，避免一上来就出现一大堆不需要的 blob
    const text = JSON.stringify(css.replace(/\n/g, '').replace(/[\s\t]+/g, ' '));
    const fileText = `
      ;(function() {
        let css${id} = null;
        Object.defineProperty(CSS, '${id}', {
          get() {
            if (!css${id}) {
              css${id} = createBlobUrl(${text}, '${type}');
            }
            return css${id};
          },
        });
      }());
    `;
    return fileText;
  });

  let cssContent = '';
  if (cssFiles.length) {
    cssContent += `function createBlobUrl(text, type) {
      const url = window.URL || window.webkitURL;
      const blob = new Blob([text], { type });
      const blobURL = url.createObjectURL(blob);
      return blobURL;
    }\n`;
    cssContent += 'const CSS = {};\n';
    cssContent += cssFiles.join('\n');
  }

  return `
    ${importLib ? `import * as SFCJS from '${importLib === true ? name : importLib}';` : ''}
    ${importLines.join('\n')}
    ${cssContent}
    ${baseUrlExp ? `SFCJS.config('baseUrl', ${baseUrlExp});` : ''}
    ${contents.join('\n')}
    ${exportUrl ? `\nexport default '${entryUrl}';\n` : ''}
  `;
}
