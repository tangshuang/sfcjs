import {
  parseHtmlToAst,
  // traverseAst as traverseHtmlAst,
} from 'abs-html';
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

  // DROP 通过clearHtml解决了
  // traverseHtmlAst(htmlAst, {
  //   '[[String]]': {
  //     enter(node, parent, index) {
  //       if (!parent) {
  //         return
  //       }
  //       // 去掉所有换行逻辑
  //       if (/^\n[\s\n]*$/.test(node)) {
  //         parent.splice(index, 1)
  //       }
  //       else if (/^\n.*?\n$/.test(node)) {
  //         const str = node.substring(1, node.length - 1)
  //         parent[index] = str
  //       }
  //     },
  //   },
  // })

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
      const createValue = () => {
        if (value && typeof value === 'object') {
          return create(value, null, vars);
        }

        if (typeof value === 'string') {
          return interpolate(value);
        }

        return value;
      };

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
          attrs.push([k, `'${url}'`]);
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
        const v = createValue();
        attrs.push([serialName(key), v]);
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
          if (name === 'attrs' || name === 'props') {
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
