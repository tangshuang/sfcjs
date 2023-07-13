import {
  each,
  resolveUrl,
  createScriptByBlob,
  insertScript,
  createReady,
  createBlobUrl,
  createScript,
} from '../utils';
import {
  createProxy, isObject, isArray,
  parse,
  remove, assign, isShallowEqual, isString,
  isInstanceOf, decideby, isFunction,
  createRandomString,
  uniqueArray,
  createSafeExp,
} from 'ts-fns';
import produce from 'immer';
import { Context } from './context';
import { config } from './config';

export const components = {};
const sources = {};

class Component {
  constructor({ url, deps, fn }) {
    this.url = url;
    this.deps = deps;
    this.fn = fn;
  }
}

export function define(url, deps, fn) {
  const baseUrl = config('baseUrl');
  const absUrl = resolveUrl(baseUrl, url);

  if (components[absUrl]) {
    throw new Error(`${absUrl}已经被注册过了`);
  }

  const component = new Component({
    url: absUrl,
    deps,
    fn,
  });
  components[absUrl] = component;

  const depComponents = deps.filter(item => item[0] === '.');

  if (!depComponents.length) {
    return component;
  }

  each(depComponents, (dep) => {
    const url = resolveUrl(absUrl, dep);
    // 必须转化为绝对路径才能从component上读取
    each(component.deps, (item, i) => {
      if (item === dep) {
        component.deps[i] = url;
      }
    });
  });
  return component;
}

// ---------------------------------------------

// 数据类型
const REACTIVE_TYPE = Symbol('reactive');
const PROP_TYPE = Symbol('prop');
// 节点类型
const TEXT_NODE = Symbol('text');

class Neure {
  // 固定信息
  type = null
  meta = null
  children = null // 内部元素的获取函数
  // 实时信息，当前状态，用于下一次渲染
  key = null
  visible = true
  attrs = null
  props = null
  events = null
  bind = null
  className = null
  style = null
  // 记录内函数的参数
  args = null
  // DOM 节点
  node = null
  parentNode = null
  // 链表关系
  child = null // 第一个字节点
  sibling = null // 第一个兄弟节点
  parent = null // 父节点

  // 记录依赖
  // 不同的类型依赖生效的域不同，普通节点对meta生效，文本节点对children生效，list节点对list生效
  deps = []

  set(data) {
    Object.assign(this, data);
  }
}

class NeureList extends Neure {
  list = null // fragment内部的内容
  repeat = null // repeat数据
}

class TextNeure extends Neure {
  text = null // TextNode内部的文本
}

class SvgNeure extends Neure {}

class AsyncNeure extends Neure {
  promise = null // 含有await指令
  data = ''
  error = ''
  status = ''
}

// ---------------------------------------------

class Brush {
  constructor(data) {
    Object.assign(this, data);
  }
}

// ---------------------------------------------

class Element {
  props = null // 外部传入的props
  context = null // 内部返回的结果

  collector = new Set()
  root = null // 被挂载到的DOM节点

  // 用于渲染的素材
  slot = null
  neure = null // 最顶级的Neure实例

  // 用于样式
  styles = null
  brushes = null
  dyeAt = null
  brushesAt = null

  // schedule = new Set()
  queue = new Set()

  relations = []

  $isCollecting = false
  $queueUpdating = false
  $isMounted = false
  $watchers = []
  $comsumeRecords = [];
  $consumeTimer = null;

  constructor(props) {
    this.props = Object.freeze(props);
  }

  watch(vars, fn) {
    const values = isArray(vars) ? vars : [vars];
    const count = values.length;
    const reactors = this.$comsumeRecords.slice(this.$comsumeRecords.length - count);
    reactors.reverse();
    // 每一次watch都清空，consumed只服务于watch
    this.$comsumeRecords.length = 0;

    // 检查是不是一致的，如果不是一致的，就直接跳过
    for (let i = 0; i < count; i ++) {
      const value = values[i];
      const reactor = reactors[i];
      if (!reactor) {
        return;
      }
      if (reactor.value !== value) {
        return;
      }
    }

    reactors.forEach((reactor) => {
      this.$watchers.push({
        reactor,
        fn,
      });
    });
  }

  reactive(getter, computed) {
    const [value, deps] = computed ? this.collect(() => getter()) : [getter(), []];

    const reactor = {
      $$typeof: REACTIVE_TYPE,
      value,
      getter,
      $id: createRandomString(8),
    };

    const create = value => createProxy(value, {
      get: (_, value) => {
        if (this.$isCollecting) {
          this.collector.add(reactor);
        }
        return value;
      },
      writable: () => false,
      receive: (...args) => {
        if (args.length === 1) {
          const [keyPath] = args;
          const next = produce(value, (value) => {
            remove(value, keyPath);
          });
          const value = create(next);
          this.update(reactor, () => value);
        } else {
          const [keyPath, nextValue] = args;
          const next = produce(value, (value) => {
            assign(value, keyPath, nextValue);
          });
          const value = create(next);
          this.update(reactor, () => value);
        }
      },
    });

    // 使它具有响应式能力
    reactor.value = create(value);

    if (deps.length) {
      this.relations.push({
        deps,
        by: reactor,
      });
    }

    return reactor;
  }

  consume(reactor) {
    if (!reactor || typeof reactor !== 'object') {
      return reactor;
    }

    if (reactor.$$typeof !== REACTIVE_TYPE) {
      return reactor;
    }

    if (this.$isCollecting) {
      this.collector.add(reactor);
    }

    this.$comsumeRecords.push(reactor);
    clearTimeout(this.$consumeTimer);
    this.$consumeTimer = setTimeout(() => {
      this.$comsumeRecords.length = 0;
    }, 60000);

    const { value } = reactor;
    return value;
  }

  collect(fn, callback) {
    const { collector } = this;
    const originCollector = new Set([...collector]);
    this.collector.clear();
    this.$isCollecting = true;
    const res = fn();
    this.$isCollecting = false;
    const deps = [...collector];
    this.collector = originCollector;
    if (callback) {
      callback(deps);
    }
    return [res, deps];
  }

  update(reactor, getter) {
    if (!reactor || typeof reactor !== 'object') {
      return getter();
    }

    if (reactor.$$typeof !== REACTIVE_TYPE) {
      return getter();
    }

    const prev = reactor.value;
    const value = getter(reactor.value);
    // eslint-disable-next-line no-param-reassign
    reactor.value = value;
    // eslint-disable-next-line no-param-reassign
    reactor.getter = () => value;

    this.relations.find((item, i) => {
      if (item.by === reactor) {
        this.relations.splice(i, 1);
        return true;
      }
      return false;
    });

    // 触发观察副作用
    const watchers = this.$watchers.filter(item => inDeps(item.reactor, [reactor]));
    if (watchers.length) {
      watchers.forEach(({ fn }) => fn(value, prev));
    }

    this.queue.add(reactor);
    this.queueUpdate();

    return reactor;
  }

  queueUpdate() {
    if (this.$queueUpdating) {
      return;
    }
    this.$queueUpdating = true;
    requestAnimationFrame(() => {
      const { queue } = this;

      if (!queue.size) {
        this.$queueUpdating = false;
        return;
      }

      // 计算依赖关系计算顺序 https://blog.csdn.net/cn_gaowei/article/details/7641649x
      const deps = []; // 被依赖的
      const depBys = []; // 依赖了别的的
      const all = new Set(); // 所有的
      const graph = []; // 按特定顺序的

      const depRelMap = new Map(); // key: reactor -> value: relation

      this.relations.forEach((item) => {
        item.deps.forEach((dep) => {
          deps.push(dep);
          depBys.push(item.by);
          all.add(dep);
        });
        all.add(item.by);
        depRelMap.set(item.by, item);
      });

      // 找出只被依赖，不需要依赖别人的
      do {
        // 它们需要被最先处理
        const onlyDeps = [...new Set([...all].filter(item => !depBys.includes(item)))];
        graph.push(onlyDeps);
        for (let i = deps.length - 1; i >= 0; i --) {
          const dep = deps[i];
          if (onlyDeps.includes(dep)) {
            // 把被加入到带处理组的删除
            deps.splice(i, 1);
            depBys.splice(i, 1);
          }
        }
      } while (deps.length);

      // 找出哪些没有被加入队列的，这些就是最后需要处理的，它们可能依赖前已经变动过的，但是，也可能不需要处理
      const needs = [...new Set([...all].filter(item => !graph.some(items => items.includes(item))))];
      graph.push(needs);

      // 根据依赖关系，计算全部变量
      let changed = [...queue];
      graph.forEach((items) => {
        each(items, (reactor) => {
          const rel = depRelMap.get(reactor);
          // 没有任何依赖的
          if (!rel || !rel.deps) {
            return;
          }
          // 重新计算，并将该项放到changed中提供给下一个组做判断
          if (rel.deps.some(dep => inDeps(dep, changed))) {
            const { getter } = reactor;
            if (!getter) {
              return;
            }
            const [value, deps] = this.collect(() => getter());
            // eslint-disable-next-line no-param-reassign
            reactor.value = value;
            // 自引用，比如自加操作等。这时将原始的依赖进行展开。同时可能有新的依赖
            if (deps.includes(reactor)) {
              deps.splice(deps.indexOf(reactor), 1, ...rel.deps);
            }
            rel.deps = uniqueDeps(deps);
            changed = uniqueDeps([...changed, reactor]);
          }
        });
      });

      // 重新构建样式
      if (this.brushes && this.brushesAt) {
        const brushesContent = this.brushes.map((brush) => {
          const { id, getter, deps, value } = brush;
          if (deps.length && inDeps(changed, deps)) {
            const [next, nextDeps] = this.collect(getter);
            // eslint-disable-next-line no-param-reassign
            brush.value = next;
            // eslint-disable-next-line no-param-reassign
            brush.deps = nextDeps;
            return `--${id}: ${next};`;
          }
          return `--${id}: ${value};`;
        }).join('\n');
        this.brushesAt.textContent = `:host {\n${brushesContent}\n}`;
      }

      this.queue.clear();
      this.$queueUpdating = false;

      // 根据变化情况更新DOM
      this.updateNeure(this.neure, changed);
    });
  }

  // should must run after setup
  async mount(el) {
    const style = document.createElement('style');
    // 忽略顶层的元素
    style.textContent = ':host, fragment { display: contents }';
    el.appendChild(style);

    if (this.styles) {
      await this.mountStyles(this.styles, el);
    }
    await this.mountNeure(this.neure, el);

    this.root = el;
    this.$isMounted = true;
  }

  mountNeure(neure, root) {
    const { type, attrs, events, child, sibling, text, visible, className, style, bind } = neure;

    const mount = (type) => {
      const node = isInstanceOf(neure, SvgNeure) ? document.createElementNS('http://www.w3.org/2000/svg', type) : document.createElement(type);
      each(attrs, (value, key) => {
        node.setAttribute(key, value);
      });
      each(events, (fn, key) => {
        node.addEventListener(key, fn);
      });
      if (className) {
        const classNames = className.split(' ');
        classNames.forEach((item) => {
          node.classList.add(item);
        });
      }
      if (style) {
        node.style.cssText = (node.style.cssText || '') + style;
      }

      if (bind) {
        const bindUpdate = (e) => {
          const nextValue = e.target.value;
          bind[0] = nextValue;
          bind[1](nextValue);
        };
        node.addEventListener('input', bindUpdate);
      }

      if (visible) {
        root.appendChild(node);
      }

      // eslint-disable-next-line no-param-reassign
      neure.node = node;
      if (child) {
        this.mountNeure(child, node);
      }

      if (bind) {
        changeInput(neure);
      }
    };

    if (isInstanceOf(type, Component)) {
      // 先挂上去占位符一样
      const node = document.createElement('t-sfc');
      // eslint-disable-next-line no-param-reassign
      neure.node = node;
      // eslint-disable-next-line no-param-reassign
      neure.parentNode = root;

      if (visible) {
        root.appendChild(node);
        this.mountComponent(neure);
        if (child) {
          this.mountNeure(child, node);
        }
      }
    } else if (isInstanceOf(neure, NeureList)) {
      if (child) {
        this.mountNeure(child, root);
      }
    } else if (isInstanceOf(neure, TextNeure)) {
      const node = document.createTextNode(text);
      root.appendChild(node);
      // eslint-disable-next-line no-param-reassign
      neure.node = node;
      // eslint-disable-next-line no-param-reassign
      neure.parentNode = root;
    } else {
      mount(type);
    }

    // eslint-disable-next-line no-param-reassign
    neure.parentNode = root;

    if (sibling) {
      this.mountNeure(sibling, root);
    }

    // 等到全部初始状态挂载完毕之后，才能进入到更新操作，有一个mounted标记控制
    if (isInstanceOf(neure, AsyncNeure)) {
      neure.promise.then((res) => {
        if (neure.status) {
          const [key, reactor] = neure.status;
          // eslint-disable-next-line no-param-reassign
          neure.args[key] = 'resolved';
          this.update(reactor, () => 'resolved');
        }
        if (neure.data) {
          const [key, reactor] = neure.data;
          // eslint-disable-next-line no-param-reassign
          neure.args[key] = res;
          this.update(reactor, () => res);
        }
      }).catch((err) => {
        if (neure.status) {
          const [key, reactor] = neure.status;
          // eslint-disable-next-line no-param-reassign
          neure.args[key] = 'rejected';
          this.update(reactor, () => 'rejected');
        }
        if (neure.error) {
          const [key, reactor] = neure.error;
          // eslint-disable-next-line no-param-reassign
          neure.args[key] = err;
          this.update(reactor, () => err);
        }
      });
    }
  }

  async mountComponent(componentNeure) {
    const { type, props, events, node, child } = componentNeure;
    // eslint-disable-next-line no-param-reassign
    componentNeure.$ready = createReady();

    // 组件在挂载的时候才去请求资源
    const element = await initComponent(type, { props, events });
    // eslint-disable-next-line no-param-reassign
    componentNeure.element = element;
    element.root = node.rootAt;

    await element.setup(child);

    if (!element.neure) { // 可能内部完全没东西
      throw new Error(`${type} 组件文件未提供渲染的内容`);
    }

    // 利用原生customElement实现slot效果
    if (child) {
      await this.mountNeure(child, node);
    }

    await element.mount(node.rootAt);

    componentNeure.$ready(true);
  }

  // 根据变化情况更新DOM
  updateNeure(neure, changed) {
    const walk = (neure) => {
      const { type, meta, children, deps, node, parentNode, args } = neure;

      let notNeedWalkToChild = false;

      if (isInstanceOf(neure, NeureList)) {
        if (!changed || (deps.length && inDeps(changed, deps))) {
          const neureList = neure;
          const {
            repeat: prevItems,
            list: prevList,
          } = neureList;
          const {
            repeat: repeatGetter,
          } = meta;
          const [{ items, itemsKey, itemKey, indexKey }, repeatDeps] = this.collect(() => repeatGetter());
          const removeList = [...prevList];

          neureList.deps = repeatDeps;
          neureList.repeat = items;

          const neures = [];
          // 将repeat从meta中去除，因为单个item在渲染时不能再提供repeat，否则会走特殊的children逻辑
          const { repeat, ...others } = meta;
          const { key: keyGetter } = meta;

          if (!isShallowEqual(items, prevItems)) {
            const updateNeure = (index) => {
              const neure = removeList[index];
              // 更新args
              neure.args = Object.assign(neure.args || {}, args);
              if (neures.length) {
                neures[neures.length - 1].sibling = neure;
              }
              neures.push(neure);
              // 从原来的列表中删除，剩下来的就是将从DOM中移除的
              removeList.splice(index, 1);
            };
            each(items, (item, index) => {
              const args = {
                [itemsKey]: items,
                [itemKey]: item,
                [indexKey]: index,
              };

              // 基于对象本身的引用来判断
              const prevIndex = prevItems.indexOf(item);
              if (prevIndex > -1) {
                const prevNeure = prevList[prevIndex];
                const index = removeList.indexOf(prevNeure);
                if (index > -1) {
                  updateNeure(prevIndex);
                  return;
                }
              }

              // 基于key来决定
              if (keyGetter) {
                const key = keyGetter(args);
                const prevIndex = removeList.findIndex(item => item.key === key);
                if (prevIndex > -1) {
                  updateNeure(prevIndex);
                  return;
                }
              }

              // 创建新的节点
              const neure = this.initNeure(type, others, children, args);
              if (neures.length) {
                neures[neures.length - 1].sibling = neure;
              }
              neures.push(neure);
            });
            each(neures, (neure) => {
              // eslint-disable-next-line no-param-reassign
              neure.parent = neureList;
            });

            neureList.child = neures[0] || null;
            neureList.list = neures;

            const sibling = decideby(() => {
              const firstNeure = removeList.find(item => item.visible && item.node);
              if (firstNeure) {
                return firstNeure.node;
              }
              const sibling = findSibling(neureList);
              return sibling;
            });

            // 更新节点
            each(neures, (neure) => {
              if (neure.node) {
                parentNode.insertBefore(neure.node, sibling);
                this.updateNeure(neure, changed);
              } else {
                this.mountNeure(neure, parentNode);
              }
            });

            // 移除已经拥有用的DOM节点
            const removeChildren = (list) => {
              each(list, (item) => {
                if (item.node) {
                  parentNode.remove(item.node);
                } else if (isInstanceOf(item, NeureList) && item.list) {
                  removeChildren(item.list);
                }
              });
            };
            removeChildren(removeList);
          }
        }
      } else if (isInstanceOf(neure, TextNeure)) {
        if (!changed || (deps?.length && inDeps(changed, deps))) {
          this.collect(() => {
            const text = children();
            // eslint-disable-next-line no-param-reassign
            neure.node.textContent = text;
            // eslint-disable-next-line no-param-reassign
            neure.text = text;
          }, (deps) => {
            // eslint-disable-next-line no-param-reassign
            neure.deps = deps;
          });
        }
      } else if (isInstanceOf(type, Component)) {
        let showOut = false;

        const {
          class: classGetter,
          style: styleGetter,
          visible: visibleGetter,
          key: keyGetter,
          attrs: attrsGetter,
          props: propsGetter,
          events: eventsGetter,
          bind: bindGetter,
        } = meta;

        this.collect(() => {
          const key = keyGetter ? keyGetter(args) : null;
          const visible = visibleGetter ? visibleGetter(args) : true;
          const attrs = attrsGetter ? attrsGetter(args) : {};
          const props = propsGetter ? propsGetter(args) : {};
          const events = eventsGetter ? eventsGetter(args) : {};
          const className = classGetter ? classGetter(args) : '';
          const style = styleGetter ? styleGetter(args) : '';
          const bind = bindGetter ? bindGetter() : null;

          // 从不显示变为显示
          showOut = visible && !neure.visible;

          if (neure.visible !== visible) {
            if (visible) {
              const sibling = findSibling(neure);
              parentNode.insertBefore(node, sibling);
            } else {
              parentNode.removeChild(node);
            }
          }

          neure.set({
            key,
            visible,
            attrs,
            props,
            events,
            className,
            style,
            bind,
          });

          // 从最开始的不显示，变为显示出来，需要新建child
          if (!neure.$ready && showOut) {
            this.mountComponent(neure);
          }
          if (!neure.child && showOut) {
            this.genChildren(neure);
            if (neure.child) {
              this.mountNeure(neure.child, neure.node);
            }
            notNeedWalkToChild = true;
          }

          if (neure.$ready) {
            neure.$ready().then(() => {
              updateComponent(neure.element, { props });
            });
          }
        }, (deps) => {
          // eslint-disable-next-line no-param-reassign
          neure.deps = deps;
        });
      } else {
        let showOut = false;

        if (!changed || (deps?.length && inDeps(changed, deps))) {
          this.collect(() => {
            const {
              class: classGetter,
              style: styleGetter,
              visible: visibleGetter,
              key: keyGetter,
              attrs: attrsGetter,
              bind: bindGetter,
            } = meta;

            const key = keyGetter ? keyGetter(args) : null;
            const visible = visibleGetter ? visibleGetter(args) : true;
            const attrs = attrsGetter ? attrsGetter(args) : {};
            const className = classGetter ? classGetter(args) : '';
            const style = styleGetter ? styleGetter(args) : '';
            const bind = bindGetter ? bindGetter() : null;

            // 从不显示变为显示
            showOut = visible && !neure.visible;

            // 重置样式相关
            node.classList.forEach((className) => {
              node.classList.remove(className);
            });
            node.style.cssText = '';

            // 移除原有的不再需要的属性
            if (neure.attrs) {
              each(neure.attrs, (_, key) => {
                if (!(key in attrs)) {
                  node.removeAttribute(key);
                }
              });
            }

            each(attrs, (value, key) => {
              node.setAttribute(key, value);
            });

            if (bind) {
              // eslint-disable-next-line no-param-reassign
              neure.bind = bind;
              changeInput(neure);
            }

            if (className) {
              const classNames = className.split(' ');
              classNames.forEach((item) => {
                node.classList.add(item);
              });
            }

            if (style) {
              node.style.cssText = (node.style.cssText || '') + style;
            }

            if (neure.visible !== visible) {
              if (visible) {
                const sibling = findSibling(neure);
                parentNode.insertBefore(node, sibling);
              } else {
                parentNode.removeChild(node);
              }
            }

            neure.set({
              key,
              visible,
              attrs,
              className,
              style,
            });
          }, (deps) => {
            // eslint-disable-next-line no-param-reassign
            neure.deps = deps;
          });
        }

        // 从最开始的不显示，变为显示出来，需要新建child
        if (!neure.child && showOut) {
          this.genChildren(neure);
          if (neure.child) {
            this.mountNeure(neure.child, neure.node);
          }
          notNeedWalkToChild = true;
        }
      }

      if (!notNeedWalkToChild && neure.child) {
        walk(neure.child);
      }

      if (neure.sibling) {
        walk(neure.sibling);
      }
    };

    walk(neure);
  }

  mountStyles(styles, root) {
    const list = [];
    const brushes = [];
    const create = (attrs) => {
      let text = '';
      each(attrs, (value, key) => {
        if (isInstanceOf(value, Brush)) {
          text += `${key}: var(--${value.id});`;
          brushes.push(value);
        } else {
          text += `${key}: ${value};`;
        }
      });
      return text;
    };
    const build = (item) => {
      const { name, attrs } = item;
      let text = `${name} {`;
      text += create(attrs);
      text += '}';
      return text;
    };
    each(styles, (item) => {
      if (isArray(item)) {
        const [type, query, ...rules] = item;
        if (isObject(query)) {
          let text = `${type} {`;
          text += [query, ...rules].map(item => (item ? create(item) : '')).filter(item => !!item)
            .join('');
          text += '}';
          list.push(text);
        } else if (type === '@import') {
          list.push(`@import "${query}";`);
        } else if (isString(query) && rules.length) {
          let text = `${type} ${query} {`;
          text += rules.map(item => (item ? build(item) : '')).filter(item => !!item)
            .join(' ');
          text += '}';
          list.push(text);
        } else if (isString(query)) {
          list.push(`${type} ${query};`);
        }
      } else if (!!item) {
        const text = build(item);
        list.push(text);
      }
    });
    const content = list.join('\n');

    if (brushes.length) {
      const brushesContent = brushes.map((brush) => {
        const { id, value } = brush;
        return `--${id}: ${value};`;
      }).join('\n');
      const brushNode = document.createElement('style');
      brushNode.textContent = `:host {\n${brushesContent}\n}`;
      root.appendChild(brushNode);
      this.brushes = brushes;
      this.brushesAt = brushNode;
    }

    const style = document.createElement('style');
    style.textContent = content;
    root.appendChild(style);
    this.dyeAt = style;
  }

  destroy() {
    this.$isMounted = false;
    this.props = null;
    this.context = null;
    this.collector.clear();
    this.queue.length = 0;
    this.relations.length = 0;
    this.root.innerHTML = '';
    this.root = null;
  }

  async setup(slot) {
    const { context } = this;
    const { render, dye } = context;

    if (dye) {
      const styles = dye();
      this.styles = styles;
    }

    this.slot = slot;
    const neure = render();
    this.neure = neure;
  }

  t(textGetter) {
    const [text, deps] = this.collect(() => textGetter());
    const node = new TextNeure();
    node.set({
      type: TEXT_NODE,
      children: textGetter,
      text,
      deps,
    });
    return node;
  }

  h(type, meta, childrenGetter) {
    if (typeof meta === 'function') {
      // eslint-disable-next-line no-param-reassign
      childrenGetter = meta;
      // eslint-disable-next-line no-param-reassign
      meta = {};
    }

    const [neure, metaDeps] = this.collect(() => this.initNeure(type, meta, childrenGetter));
    neure.deps = metaDeps;

    if (isInstanceOf(neure, NeureList)) {
      each(neure.list, this.genChildren.bind(this));
    } else {
      this.genChildren(neure);
    }

    return neure;
  }

  initNeure(type, meta = {}, childrenGetter, args) {
    const { repeat: repeatGetter, await: awaitGetter } = meta;

    if (repeatGetter) {
      const neureList = new NeureList();
      neureList.set({
        type,
        meta,
        children: childrenGetter,
        args,
      });
      const neures = [];
      const [{ items, itemsKey, itemKey, indexKey }, repeatDeps] = this.collect(() => repeatGetter());
      neureList.deps = repeatDeps;
      neureList.repeat = items;

      const { repeat, ...others } = meta;

      each(items, (item, index) => {
        const args = {
          [itemsKey]: items,
          [itemKey]: item,
          [indexKey]: index,
        };
        const neure = this.initNeure(type, others, childrenGetter, args);
        if (neures.length) {
          neures[neures.length - 1].sibling = neure;
        }
        neures.push(neure);
      });
      each(neures, (neure) => {
        // eslint-disable-next-line no-param-reassign
        neure.parent = neureList;
      });

      neureList.child = neures[0] || null;
      neureList.list = neures;
      return neureList;
    }

    if (awaitGetter) {
      const { await: _await, ...others } = meta;
      const { promise, data, error, status } = awaitGetter(); // 无法进行响应式，只能一次使用

      const stat = status ? [status, this.reactive(() => 'pending')] : null;
      const dt = data ? [data, this.reactive(() => null)] : null;
      const err = error ? [error, this.reactive(() => null)] : null;

      const passedArgs = args || {};
      const localArgs = { ...passedArgs };
      if (stat) {
        const [key, value] = stat;
        localArgs[key] = value;
      }

      // 真正实例化
      const neure = createNeure(type, others, childrenGetter, localArgs, AsyncNeure);
      neure.set({
        promise,
        status: stat,
        data: dt,
        error: err,
      });

      this.genChildren(neure);
      return neure;
    }

    const neure = createNeure(type, meta, childrenGetter, args, type === 'svg' || this.$$inSvg ? SvgNeure : Neure);
    this.genChildren(neure);
    return neure;
  }

  genChildren(neure) {
    const { visible, children, args } = neure;

    if (!visible) {
      return;
    }

    if (!children) {
      return;
    }

    if (isInstanceOf(neure, SvgNeure)) {
      this.$$inSvg = true;
    }
    const subs = children(args);
    if (this.$$inSvg) {
      delete this.$$inSvg;
    }

    subs.reduce((backer, item) => {
      // eslint-disable-next-line no-param-reassign
      item.parent = neure;
      if (!parent.child) {
        parent.child = item;
      }

      if (backer) {
        // eslint-disable-next-line no-param-reassign
        backer.sibling = item;
      }
      return item;
    }, null);
    // eslint-disable-next-line prefer-destructuring,no-param-reassign
    neure.child = subs[0];
  }

  r(name, ...args) {
    const attrs = {};
    args.forEach((item) => {
      if (isObject(item)) {
        each(item, (value, key) => {
          if (isFunction(value)) {
            const [v, deps] = this.collect(value);
            attrs[key] = new Brush({
              value: v,
              deps,
              getter: value,
              id: createRandomString(12),
            });
          } else {
            attrs[key] = value;
          }
        });
      }
    });
    return { name, attrs };
  }
}

export async function initComponent(absUrl, meta = {}) {
  const { props = {} } = meta;
  const element = new Element(props);
  const currentOrigin = window.location.origin;

  let component = null;
  if (isInstanceOf(absUrl, Component)) {
    component = absUrl;
  } else if (components[absUrl]) {
    component = components[absUrl];
  } else {
    const shortUrl = absUrl.indexOf(currentOrigin) === 0 ? absUrl.replace(currentOrigin, '') : absUrl;
    if (components[shortUrl]) {
      component = components[shortUrl];
    }
  }

  if (!component) {
    throw new Error(`${absUrl} 组件尚未加载`);
  }

  const { deps, fn } = component;
  await loadDepComponents(deps);

  const { events = {} } = meta;

  // 通过sfc:协议可以引入的接口
  const scope = {
    ...components,
    props: createProxy({}, {
      get: (keyPath) => {
        const value = parse(element.props, keyPath);
        if (element.$isCollecting) {
          element.collector.add({
            $$typeof: PROP_TYPE,
            key: keyPath[0],
            value,
          });
        }
        return value;
      },
      writable: () => false,
      extensible: () => false,
    }),
    emit: (event, data) => {
      const callback = events[event];
      if (!callback) {
        return;
      }
      return callback(data);
    },
    query: selector => element.root?.querySelector(selector),
    resolve: uri => resolveUrl(absUrl, uri),
    computed: getter => element.reactive(getter, true),
    update: element.queueUpdate.bind(element),
    watch: element.watch.bind(element),
  };
  const vars = deps.map(dep => scope[dep]);

  const inside = Object.freeze({
    h: element.h.bind(element),
    t: element.t.bind(element),
    r: element.r.bind(element),
    reactive: element.reactive.bind(element),
    consume: element.consume.bind(element),
    update: element.update.bind(element),
  });

  const context = await Promise.resolve(fn.call(inside, ...vars));
  element.context = context;

  return element;
}

export function updateComponent(element, meta) {
  const originProps = element.props;
  const { props = {} } = meta;
  const originKeys = Object.keys(originProps);
  const newKeys = Object.keys(props);
  // 当前已经渲染出来的props
  const keys = uniqueArray([...originKeys, ...newKeys]);
  // 找出发生变化的props
  const changed = keys.map((key) => {
    const value = props[key];
    if (originProps[key] !== value) {
      return {
        key,
        value,
      };
    }
    return null;
  }).filter(item => !!item);
  // 更新组件
  // eslint-disable-next-line no-param-reassign
  element.props = props;
  each(changed, (o) => {
    const reactor = {
      $$typeof: PROP_TYPE,
      ...o,
    };
    element.queue.add(reactor);
  });
  element.queueUpdate();
}

async function loadDepComponents(deps) {
  const components = deps.filter(item => /^[a-z]+?:\/\//.test(item));
  if (!components.length) {
    return;
  }
  await Promise.all(components.map(url => Context.useComponent(url)
    .then(chunk => insertBlob(url, chunk))));
}

export async function insertBlob(absUrl, { code, cssRefs, jsRefs }) {
  if (jsRefs && jsRefs.length) {
    await Promise.all(jsRefs.map(async (item) => {
      const { src, url, type } = item;
      if (document.querySelector(`script[src="${url}"]`)) {
        return;
      }
      const script = createScript(url, type);
      script.setAttribute('sfc-src', src);
      await insertScript(script);
    }));
  }

  let contents = code;

  if (cssRefs && cssRefs.length) {
    cssRefs.forEach(({ code, type, url, src }) => {
      const blob = sources[url] || createBlobUrl(code, type);
      contents = contents.replace(new RegExp(createSafeExp(`sfc:${src}`), 'gmi'), blob);
      if (!sources[url]) {
        sources[url] = src;
      }
    });
  }

  const script = createScriptByBlob(contents);
  script.setAttribute('sfc-src', absUrl);
  await insertScript(script);
}

function createNeure(type, meta, children, args, NeureClass) {
  const {
    class: classGetter,
    style: styleGetter,
    visible: visibleGetter,
    key: keyGetter,
    attrs: attrsGetter,
    props: propsGetter,
    events: eventsGetter,
    bind: bindGetter,
  } = meta;

  const key = keyGetter ? keyGetter(args) : null;
  const visible = visibleGetter ? visibleGetter(args) : true;
  const attrs = attrsGetter ? attrsGetter(args) : {};
  const props = propsGetter ? propsGetter(args) : {};
  const events = eventsGetter ? eventsGetter(args) : {};
  const className = classGetter ? classGetter(args) : '';
  const style = styleGetter ? styleGetter(args) : '';
  const bind = bindGetter ? bindGetter() : null;

  const neure = new NeureClass();
  neure.set({
    type,
    meta,
    children,

    args,

    key,
    visible,
    attrs,
    props,
    events,
    className,
    style,
    bind,
  });

  return neure;
}

function uniqueDeps(deps) {
  return deps.filter((item, i) => {
    if (deps.indexOf(item) !== i) {
      return false;
    }
    if (
      item.$$typeof === PROP_TYPE
      && deps.findIndex(dep => dep.$$typeof === PROP_TYPE && dep.key === item.key) !== i
    ) {
      return false;
    }
    return true;
  });
}

function inDeps(dep, deps) {
  if (isArray(dep)) {
    return dep.some(item => inDeps(item, deps));
  }

  if (deps.includes(dep)) {
    return true;
  }

  if (
    dep.$$typeof === PROP_TYPE
    && deps.some(item => item.$$typeof === PROP_TYPE && item.key === dep.key)
  ) {
    return true;
  }

  return false;
}

function findSibling(neure) {
  const { sibling } = neure;

  if (!sibling) {
    return null;
  }

  if (isInstanceOf(sibling, NeureList)) {
    const { child } = sibling;
    if (child.visible) {
      return child.node;
    }

    const next = findSibling(child);
    if (next) {
      return next;
    }
  }

  if (sibling.visible) {
    return neure.sibling.node;
  }

  return findSibling(sibling);
}

function changeInput(neure) {
  const { bind, node, type } = neure;

  if (type === 'select') {
    const options = [...node.querySelectorAll(':scope > option')];
    const bindValue = bind[0];
    node.value = bindValue;
    options.forEach((option) => {
      if (option.getAttribute('value') === bindValue) {
        option.setAttribute('selected', 'selected');
      } else {
        option.removeAttribute('selected');
      }
    });
  } else if (type === 'textarea') {
    const bindValue = bind[0];
    node.value = bindValue;
    node.innerHTML = bindValue;
  } else if (type === 'input') {
    const bindValue = bind[0];
    node.value = bindValue;
    node.setAttribute('value', bindValue);
  }
}
