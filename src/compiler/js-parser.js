/* eslint-disable brace-style */
import { isAbsUrl } from '../utils';
import { isUndefined, createRandomString } from 'ts-fns';

const OPERATORS = ['++', '--', '**'];
const SPECIARES = ['(', ')', '[', ']', '{', '}', ';', '\n', '='];
const MODIFIERS = ['+=', '-=', '*=', '/=', '%='];

const isSign = (token, signs = [...OPERATORS, ...SPECIARES, ...MODIFIERS]) => signs.includes(token);

export function tokenize(code) {
  const tokens = [];

  let cursor = 0;
  let token = '';
  let str = '';

  const pushToken = () => {
    if (token) {
      const content = token.trim() || token.replace(/[\s\t\n]+/, ' ');
      tokens.push(content);
      token = '';
    }
  };
  const pushStr = () => {
    if (str) {
      const content = str.trim() || str.replace(/[\s\t\n]+/, ' ');
      tokens.push(content);
      str = '';
    }
  };
  const push = () => {
    pushToken();
    pushStr();
  };

  const quotes = [];

  for (let len = code.length; cursor < len; cursor ++) {
    const char = code[cursor];

    if (['"', '\'', '`'].includes(char)) {
      const latest = quotes[quotes.length - 1];
      if (latest && latest === char) {
        quotes.pop();
        token += char;
        if (!quotes.length) {
          tokens.push(token);
          token = '';
        }
      } else {
        quotes.push(char);
        pushStr();
        token += char;
      }
      continue;
    }

    if (quotes.length) {
      pushStr();
      token += char;
      continue;
    }

    const twoChars = char + code[cursor + 1];
    if ([...OPERATORS, ...MODIFIERS].includes(twoChars)) {
      push();
      tokens.push(twoChars);
      cursor += 1;
      continue;
    }

    if (SPECIARES.includes(char)) {
      push();
      tokens.push(char);
      continue;
    }

    if (token && char === ':') {
      token += ':';
      tokens.push(token);
      token = '';
      continue;
    }

    if (token && char === ' ') {
      let following = ' ';
      let i = cursor + 1;
      let next = code[i];
      while (next === ' ') {
        following += ' ';
        i += 1;
        next = code[i];
      }

      if (next === ':') {
        token += `${following}:`;
        cursor = i;
        tokens.push(token);
        token = '';
      } else {
        tokens.push(token);
        token = '';
        str = ' ';
      }

      continue;
    }

    if (/\w/.test(char)) {
      pushStr();
      token += char;
      continue;
    }

    pushToken();
    str += char;
  }

  push();

  // // 解析 `` 字符串模板
  // for (let i = 0, len = tokens.length; i < len; i ++) {
  //   const token = tokens[i];
  //   if (!/^`[\w\W]+\$\{[\w\W]+\}[\w\W]+`$/.test(token)) {
  //     continue;
  //   }

  //   token.replace(/\$\{([\W\w]+)\}/g, () => {});

  // }

  // // 清洗
  // // 把放置在符号前后的空格清洗掉
  // for (let i = 0, len = tokens.length; i < len; i ++) {
  //   const token = tokens[i];
  //   if (token === ' ' && (isSign(tokens[i - 1]) || isSign(tokens[i + 1]))) {
  //     tokens.splice(i, 1);
  //     i -= 1;
  //     len -= 1;
  //   }
  // }

  // console.log(code, tokens)
  return tokens;
}

export function parseJs(sourceCode, defaultDeps = [], defaultVars = {}, ignoreVars = {}) {
  const deps = [...defaultDeps];
  const imports = [];
  const components = [];
  let useComputed = false;

  const useProtol = (_, declares, src) => {
    const decl = declares.trim();
    if (src.indexOf('.') === 0 || src.indexOf('/') === 0 || isAbsUrl(src)) {
      components.push([decl, src]);
      deps.push([decl, src, true]);
    } else {
      deps.push([decl, src]);
    }
    if (src === 'computed') {
      useComputed = true;
    }
    return '';
  };

  const lines = sourceCode
    .replace(/import(.+?|\{[\w\W]+?\})from\s*?['"]sfc:(.+?)['"][;\n$]/gmi, useProtol)
    .replace(/const (.+?|\{[\w\W]+?\})\s*?=\s*?await\s*?import\(['"]sfc:(.+?)['"]\)[;\n$]/gmi, useProtol)
    .replace(/import(.+?|\{[\w\W]+?\})from\s*?['"](.+?)['"][;\n$]/gmi, (_, declares, src) => {
      imports.push([declares.trim(), src]);
      return '';
    });

  const scripts = lines.split('\n').reduce((lines, current) => {
    const last = lines[lines.length - 1];
    const isCurrentEmpty = !current.trim();
    if (!last && isCurrentEmpty) {
      return lines;
    }

    if (!last) {
      lines.push(current);
      return lines;
    }

    const isLastEmpty = !last.trim();
    if (isLastEmpty && isCurrentEmpty) {
      return lines;
    }

    lines.push(current);
    return lines;
  }, [])
    .join('\n');

  const tokens = tokenize(scripts);

  const vars = { ...defaultVars };

  const createFn = (code, ignores) => parseJs(code, deps, vars, { ...ignoreVars, ...ignores }).code;
  const createComputed = (code, ignores) => createFn(code.substring(9, code.length - 1), ignores);

  const createExp = (name, value, ignores) => {
    const varName = name.trim();
    vars[varName] = 1;
    const varValue = value.trim();

    // 本身就是经过编译后的值
    if (varValue.indexOf('_sfc.') === 0 || varValue.indexOf('this.') === 0) {
      return [varName, varValue];
    }

    // 通过computed创建reactive，需要把computed里面函数的内容给转一遍
    const isComputed = useComputed && /^computed\([\w\W]+\)$/.test(varValue);
    if (isComputed) {
      const computedExp = createComputed(varValue, ignores);
      return [varName, computedExp, 1];
    }

    // 赋值了一个函数，需要把函数的内容也给转化一遍
    if (/^function\s*\(/.test(varValue) || /^\(\)\s*=>\s*\{/.test(varValue)) {
      const fnExp = createFn(varValue, ignores);
      return [varName, fnExp, 2];
    }

    const varExp = varValue[0] === '{' ? `(${varValue})` : varValue;
    return [varName, varExp];
  };

  const createConsume = (varName) => {
    if (!vars[varName]) {
      return varName;
    }
    if (ignoreVars[varName]) {
      return varName;
    }
    return `_sfc.consume(${varName})`;
  };

  const createReactive = (code, ignores) => {
    const destructor = /^let\s+([{[])([\w\W]+)([}\]])\s+=([\w\W]+?);$/;
    if (destructor.test(code)) {
      return code.replace(destructor, (_, $1, names, $2, value) => {
        const variables = names.split(',');

        const varValue = value.trim();
        const deconstructFrom = `sfc$${createRandomString(8)}`;
        const isComputed = useComputed && /^computed\([\w\W]+\)$/.test(varValue);
        const computedExp = isComputed ? createComputed(varValue, ignores) : null;
        const varExp = computedExp ? `computed(${computedExp})` : varValue;
        const outs = [`const ${deconstructFrom} = ${varExp};`];

        variables.forEach((str) => {
          const [name, defaultValue] = str.split('=').map(item => item.trim());

          vars[name] = 1;

          if (isUndefined(defaultValue)) {
            const code = [
              `let ${name} = _sfc.reactive(() => {`,
              `const ${$1}${names}${$2} = _sfc.consume(${deconstructFrom});`,
              `return ${name};`,
              '}, true);',
            ].join('');
            outs.push(code);
          }
          else {
            const code = [
              `let ${name} = _sfc.reactive(() => {`,
              `const ${$1}${names}${$2} = _sfc.consume(${deconstructFrom});`,
              `if (typeof ${name} === 'undefined') {return ${defaultValue};}`,
              `return ${name};`,
              '}, true);',
            ].join('');
            outs.push(code);
          }
        });

        return outs.join('\n');
      });
    }

    const computed = /^let\s+(\w+)\s*=\s*([\w\W]+?)\s*;$/;
    if (computed.test(code)) {
      return code.replace(computed, (_, name, value) => {
        const [varName, varExp, type] = createExp(name, value, ignores);
        if (type === 2) {
          return `let ${varName} = ${varExp};`;
        }
        if (type === 1) {
          return `let ${varName} = computed(${varExp});`;
        }
        return `let ${varName} = _sfc.reactive(() => ${varExp}, true);`;
      });
    }

    const variable = /^var\s+(\w+)\s*=\s*([\w\W]+?)\s*;$/;
    if (variable.test(code)) {
      return code.replace(variable, (_, name, value) => {
        const [varName, varExp, type] = createExp(name, value, ignores);
        if (type === 2) {
          return `let ${varName} = ${varExp};`;
        }
        if (type === 1) {
          // 用var去接住computed是无效的，不会有computed效果
          return `var ${varName} = _sfc.reactive(${varExp});`;
        }
        return `var ${varName} = _sfc.reactive(() => ${varExp});`;
      });
    }

    return code;
  };
  const createUpdate = code => code.replace(/(.*?)=([\w\W]+?);$/, (_, name, value) => {
    const varName = name.trim();
    const varValue = value.trim();
    return `${varName} = _sfc.update(${varName}, ${varName} => ${varValue});`;
  });

  // 匹配对应的token
  // next为一个函数，参数为一个函数，执行该参数函数相当于执行下一个索引的token的match
  const find = (index, determine, ignore, next) => {
    let curr = index;
    let nextToken = tokens[curr]?.trim();

    while (
      (typeof ignore === 'function' && ignore(nextToken))
      || (Array.isArray(ignore) && ignore.includes(nextToken))
      || (typeof ignore === 'string' && ignore === nextToken)
    ) {
      curr += 1;
      nextToken = tokens[curr]?.trim();
      if (curr >= tokens.length) {
        nextToken = '';
        break;
      }
    }

    if (
      (typeof determine === 'function' && determine(nextToken))
      || (Array.isArray(determine) && determine.includes(nextToken))
      || (typeof determine === 'string' && determine === nextToken)
    ) {
      if (next) {
        const nextMatch = (determine, ignore, next) => match(curr + 1, determine, ignore, next);
        const res = next(nextMatch);
        if (res) {
          return curr;
        }
      } else {
        return curr;
      }
    }

    return -1;
  };
  const match = (...args) => find(...args) > -1;

  /**
   * 通过遍历代码来生成新代码
   * @param {*} initIndex 初始位置号，注意，是指在tokens中的位置号
   * @param {*} initCode 初始代码，指将要生成的代码，在initIndex之前已经生成好的代码，initIndex之后的代码即将生成
   * @param {*} wrap 包裹函数，对单一token进行处理的函数
   * @param {*} create 创建函数，对整个块处理的函数
   * @returns [code, i] -> code: 最终生成的代码，i下一个位置号
   */
  const walkWrap = (initIndex, initCode, wrap, create) => {
    const localScope = [];
    let i = initIndex;
    let code = initCode;

    const token = tokens[i];
    const len = tokens.length;
    const start = ['(', '[', '{'];
    const end = [')', ']', '}'];
    let part = token;

    const ignores = {};
    const createOffset = i => n => tokens[i + n];

    i += 1;
    let next = tokens[i];
    next = wrap(next, createOffset(i));
    part += next;

    while (1) {
      if (i >= len) {
        code += create ? create(part, ignores) : part;
        break;
      }

      // 结束标记
      if (!localScope.length && next === ';') {
        code += create ? create(part, ignores) : part;
        break;
      }

      if (start.includes(next)) {
        localScope.push(next);
      } else if (end.includes(next)) {
        const index = end.indexOf(next);
        const latest = localScope[localScope.length - 1];

        if (latest !== start[index]) {
          throw new Error(`${start[index]} 尚未关闭 at ${i} ${tokens[i - 1]} ${token} ${tokens[i + 1]}`);
        }

        localScope.pop();
      }

      i += 1;
      next = tokens[i];
      next = wrap(next, createOffset(i));
      part += next;

      // 记录，后续更深的作用域里面不需要在wrap该变量
      if (vars[next]) {
        ignores[next] = 1;
      }
    }

    return [code, i];
  };

  // 对变量进行包裹
  const wrap = (token, offset) => {
    const after = offset(1);
    const after2 = offset(2);
    // 变量被赋值，此时，不应该被包裹
    const signs = [...OPERATORS, ...MODIFIERS, '='];
    if (vars[token] && !((after === ' ' && isSign(after2, signs)) || isSign(after, signs))) {
      return createConsume(token);
    }
    return token;
  };

  let code = '';
  for (let i = 0, len = tokens.length; i < len; i ++) {
    const token = tokens[i];
    // 声明变量
    if (token === 'let' || token === 'var') {
      const [newCode, newIndex] = walkWrap(i, code, wrap, createReactive);

      code = newCode;
      i = newIndex;
    }
    // 声明常量
    else if (token === 'const') {
      const [newCode, newIndex] = walkWrap(i, code, wrap);

      code = newCode;
      i = newIndex;
    }
    // 赋值操作
    else if (
      vars[token.trim()] && match(i + 1, '=', '', nextMatch => !nextMatch('='))
    ) {
      const [newCode, newIndex] = walkWrap(i, code, wrap, createUpdate);

      code = newCode;
      i = newIndex;
    }
    // 自加自减 a += 1
    else if (
      vars[token.trim()] && match(i + 1, token => MODIFIERS.includes(token), '')
    ) {
      const varname = token.trim();
      const create = (code) => {
        const exp = code.substr(0, code.length - 1);
        return `${varname} = _sfc.update(${varname}, ${varname} => ${exp});`;
      };

      const [newCode, newIndex] = walkWrap(i, code, wrap, create);

      code = newCode;
      i = newIndex;
    }
    // 一元操作
    // a ++
    else if (
      vars[token.trim()] && match(i + 1, token => OPERATORS.includes(token), '')
    ) {
      i = find(i + 1, token => OPERATORS.includes(token), '');
      const operator = tokens[i];
      const varname = token.trim();

      const exp = `${varname} = _sfc.update(${varname}, ${varname} => (${varname} ${operator},${varname}))`; // 由于直接匹配，不需要在末尾加;
      code += exp;
    }
    // 普通消费
    else if (vars[token] && !match(i - 1, '.')) {
      const next = createConsume(token);
      code += next;
    }
    // 没有任何特征
    else {
      code += token;
    }
  }

  return {
    imports,
    deps,
    components: components.reduce((obj, curr) => {
      const [name, src] = curr;
      // eslint-disable-next-line no-param-reassign
      obj[name] = src;
      return obj;
    }, {}),
    vars,
    code,
  };
}
