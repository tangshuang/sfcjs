import { resolveUrl, randomString, createBlobUrl } from '../utils';
import { Context } from '../core/context';

const { currentScript } = document;
const { src } = currentScript;
const { href } = window.location;
const baseUrl = resolveUrl(href, src);
const workerSrc = currentScript.getAttribute('worker-src') || resolveUrl(baseUrl, './worker.js');
const workerUrl = createBlobUrl(`importScripts('${workerSrc}')`);
const worker = new Worker(workerUrl);

const toolsSrc = currentScript.getAttribute('tools-src');
if (toolsSrc) {
  worker.postMessage(JSON.stringify({ type: 'tools', src: resolveUrl(baseUrl, toolsSrc) }));
}

function run(data) {
  return new Promise((resolve) => {
    const id = randomString();
    worker.postMessage(JSON.stringify({ ...data, id }));
    const onComplete = () => {
      worker.removeEventListener('message', onSuccess);
    };
    const onSuccess = (e) => {
      if (!e.data) {
        return;
      }

      const res = JSON.parse(e.data);
      if (data.type !== res.type) {
        return;
      }

      if (id !== res.id) {
        return;
      }

      const { code } = res;
      if (!code) {
        return;
      }

      resolve(code);
      onComplete();
    };
    worker.addEventListener('message', onSuccess);
  });
}

function loadComponentCode(src) {
  return run({ type: 'init', src });
};

function compileComponentCode(src, text) {
  return run({ type: 'compile', src, text });
}

Context.loadComponentCode = loadComponentCode;
Context.compileComponentCode = compileComponentCode;
