import { each, camelcase, clearHtml, resolveUrl } from '../utils';
import { tokenize } from './js-parser';

export function parseHtml(sourceCode, components, givenVars, source) {
  const html = clearHtml(sourceCode.trim());
  const htmlAst = parseHtmlToAst(html);

  const consumeVars = (code, vars = {}) => {
    const tokens = tokenize(code);
    const localVars = { ...givenVars, ...vars };
    each(tokens, (item, i) => {
      if (localVars[item] && tokens[i - 1] !== '.') {
        tokens[i] = `_sfc.consume(${item})`;
      }
    });
    const res = tokens.join('');
    return res;
  };

  let code = '() => {return ';

  const interpolate = (str, vars) => {
    const res = str.replace(/{{(.*?)}}/g, (_, $1) => `\${${consumeVars($1, vars)}}`);
    return `\`${res}\``;
  };

  const create = (obj, type, vars = {}) => {
    const attrs = [];
    const props = [];
    const events = [];
    const directives = [];
    const args = [];

    // 序列化名称，避免作为属性名时有非字符在其中
    const serialName = (str) => {
      if (/\W/.test(str)) {
        return `['${str}']`;
      }
      return str;
    };

    each(obj, (value, key) => {
      if (key.indexOf(':') === 0) {
        const res = value;
        const realKey = key.substr(1);
        const k = camelcase(realKey);
        props.push([k, res]);
      } else if (key.indexOf('@') === 0) {
        const k = key.substr(1);
        events.push([k, `event => {${value}}`]);
      } else if (/^\(.*?\)$/.test(key)) {
        const k = key.substring(1, key.length - 1);
        if (k === 'src' || k === 'href') {
          const url = resolveUrl(source, value);
          attrs.push([k, url]);
        } else if (k === 'if') {
          directives.push(['visible', value]);
          args.push(null);
        } else if (k === 'repeat') {
          const matched = value.match(/^(.+?)(,(.+?))?in (.+?)$/);
          if (!matched) {
            throw new Error('repeat 语法不正确 repeat="item,index in items"');
          }

          const [, _item, , _index, _items] = matched;
          const [item, index, items] = [_item.trim(), _index ? _index.trim() : null, _items.trim()];
          directives.push(['repeat', `{items:${items},itemKey:'${item}'${index ? `,indexKey:'${index}'` : ''}}`, true]);
          args.push(...[item, index].filter(Boolean));
        } else if (k === 'key') {
          directives.push(['key', value]);
        } else if (k === 'class') {
          directives.push(['class', value]);
        } else if (k === 'style') {
          directives.push(['style', value]);
        } else if (k === 'bind') {
          const allows = ['input', 'textarea', 'select'];
          if (!allows.includes(type)) {
            throw new Error(`bind 不能在 ${type} 上使用，只限于 ${allows.join(',')}`);
          }

          directives.push(['bind', `[_sfc.consume(${value}), v => _sfc.update(${value}, () => v)]`, true, true]);
        } else if (k === 'html') {
          directives.push(['html', value]);
        }
      } else {
        attrs.push([serialName(key), value]);
      }
    });

    const finalArgs = args.filter(Boolean).join(',');
    const finalArgsStr = finalArgs ? `{${finalArgs}}` : '';
    const finalVars = args.filter(Boolean).reduce((map, curr) => ({ ...map, [curr]: 1 }), vars);

    const data = [
      ['props', props],
      ['attrs', attrs],
      ['events', events],
    ]
      .map((item) => {
        const [name, info] = item;
        if (!info.length) {
          return null;
        }
        let res = `${name}:(${finalArgsStr}) => ({`;
        res += info.map(([key, value]) => {
          if (value && typeof value === 'object') {
            const v = create(value, null, finalVars);
            return `${key}:${v}`;
          }

          if (name === 'attrs' && typeof value === 'string') {
            const v = interpolate(value, finalVars);
            return `${key}:${v}`;
          }

          if (name === 'props' && typeof value === 'string') {
            const v = consumeVars(value, finalVars);
            return `${key}:${v}`;
          }

          return `${key}:${value}`;
        }).join(',');
        res += '})';
        return res;
      })
      .filter(Boolean)
      .concat(directives.map((item) => {
        const [name, value, nonArgs, nonVar] = item;
        const exp = nonVar ? value : consumeVars(value, finalVars);
        return `${name}:(${nonArgs ? '' : finalArgsStr}) => ${value[0] === '{' ? `(${exp})` : exp}`;
      }))
      .filter(Boolean)
      .join(',');

    return [data ? `{${data}}` : '', args];
  };

  const build = (astNode, vars = {}) => {
    const [type, props, ...children] = astNode;

    if (!/^[a-zA-Z]/.test(type)) {
      return null;
    }

    let data = '';
    let args = [];
    const subs = [];

    if (props) {
      [data, args] = create(props, type, vars);
    }

    const subArgs = args.filter(Boolean);
    const subArgsStr = subArgs.length ? `{${subArgs.join(',')}}` : '';
    const subVars = subArgs.reduce((map, key) => ({ ...map, [key]: 1 }), { ...vars });

    if (children.length && children.some(Boolean)) {
      each(children, (child) => {
        if (typeof child === 'string') {
          const text = interpolate(child, subVars);
          const node = `_sfc.t(() => ${text})`;
          subs.push(node);
        } else {
          const node = build(child, subVars);
          if (node !== null) {
            subs.push(node);
          }
        }
      });
    }

    const componentName = camelcase(type, true);
    const component = components && components[componentName] ? componentName : `'${type}'`;

    const inter = (content) => {
      if (subArgsStr) {
        return consumeVars(content, subArgs);
      }
      return content;
    };
    const inner = subs.length ? `(${subArgsStr}) =>${inter(`[${subs.join(',')}]`)}` : null;
    const params = [component, data, inner].filter(Boolean);
    const code = `_sfc.h(${params.join(',')})`;
    return code;
  };

  code += build(htmlAst);
  code += ';}';

  return { code };
}

const SELF_CLOSE_TAGS = [
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
];

/**
 * 将html字符串解析为ast
 * @param {string} html
 * @param {function} visit 访问第一次生成时的节点，返回新节点信息
 * @returns ast
 */
function parseHtmlToAst(html, visit) {
  const nest = [];

  const len = html.length;

  let inTagBegin = null;
  let inTag = null;

  const nodes = [];

  for (let i = 0; i < len; i += 1) {
    let char = html[i];
    const next = html[i + 1];
    // 关闭标签
    if (inTag && char === '<' && next === '/') {
      while (char !== '>') {
        i += 1;
        char = html[i];
      }

      // TODO check intag

      const node = inTag;
      if (node.length < 3) {
        node[1] = node[1] || null;
        node[2] = '';
      }

      nest.pop();
      inTag = nest[nest.length - 1];
    }
    // 开始一个标签
    else if (!inTagBegin && char === '<' && html[i + 1] !== ' ') {
      if (html[i + 1] === '!' && html[i + 2] === '-' && html[i + 3] === '-') {
        const comment = ['#comment', null];
        let content = '';

        i += 4;
        char = html[i];

        while (!(char === '-' && html[i + 1] === '-' && html[i + 2] === '>')) {
          content += char;

          i += 1;
          char = html[i];
        }

        comment[2] = content;
        const parent = nest.length ? nest[nest.length - 1] : nest;
        parent.push(comment);

        i += 2;
        continue;
      }

      let tag = '';

      i += 1;
      char = html[i];

      while (char !== ' ' && char !== '>') {
        tag += char;

        i += 1;
        char = html[i];
      }

      const node = [tag.trim()];
      inTagBegin = node;
      nodes.push(node);

      i -= 1;
    }
    // 属性
    else if (inTagBegin && char === ' ') {
      let quota = '';
      let name = '';
      let value = '';

      const node = inTagBegin;
      const putAttr = (data) => {
        name = name.trim();
        if (!name) {
          return;
        }

        node[1] = node[1] || {};
        node[1][name] = data;
        name = '';
        value = '';
        quota = '';
      };

      while (i < len) {
        i += 1;
        char = html[i];

        // 忽略空格
        if (!quota && char === ' ') {
          // 有些属性被放在引号中，有空格
          if (name[0] !== '"' && name[0] !== '\'') {
            // 没有值的属性结束
            if (name) {
              putAttr(null);
            }
            continue;
          }
        }

        // 立即自关闭标签，例如 <img />
        if (!quota && char === '/' && html[i + 1] === '>') {
          const parent = nest.length ? nest[nest.length - 1] : nest;
          parent.push(node);
          inTagBegin = null;
          i += 1;
          putAttr(null);
          break;
        }

        // 关闭开始标签，例如 <div >
        if (!quota && char === '>') {
          i -= 1;
          putAttr(null);
          break;
        }

        // 属性名结束，值开始
        if (!quota && char === '=') {
          i += 1;
          char = html[i];
          quota = char;
          continue;
        }

        if (!quota) {
          name += char;
          continue;
        }

        // 值结束
        if (quota && (char === quota) && html[i - 1] !== '\\') {
          putAttr(value);
          continue;
        }

        if (quota) {
          value += char;
          continue;
        }
      }
    }
    // 开始标签结束
    else if (inTagBegin && char === '>') {
      const node = visit ? visit(inTagBegin) : inTagBegin;
      const parent = nest.length ? nest[nest.length - 1] : nest;
      parent.push(node);
      nest.push(node);
      node[1] = node[1] || null; // 强制props
      inTagBegin = null;
      inTag = node;

      if (SELF_CLOSE_TAGS.indexOf(node[0]) > -1) {
        nest.pop();
        inTag = nest[nest.length - 1];
      }
    } else if (inTag) {
      const node = inTag;
      if (node.length < 3) {
        node[1] = node[1] || null;
        node[2] = char;
      } else if (typeof node[node.length - 1] === 'string') {
        node[node.length - 1] += char;
      } else {
        node.push(char);
      }
    }
  }

  return nest[0];
}
