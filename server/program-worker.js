import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';

// No Node objects, callbacks, module loader, filesystem or network are exposed.
// Only JSON crosses the WebAssembly guest boundary.
let runtime, context;
try {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 1024 });
  const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  runtime = module.newRuntime();
  runtime.setMemoryLimit(48 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + workerData.budgetMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  context = runtime.newContext();
  const call = workerData.validate ? `if (typeof act !== 'function') throw Error('请定义 function act(state)'); 'ok';`
    : `if (typeof act !== 'function') throw Error('请定义 function act(state)');
       JSON.stringify(act(JSON.parse(${JSON.stringify(JSON.stringify(workerData.state))})));`;
  const result = context.evalCode(workerData.source + '\n;' + call, 'submitted-bot.js');
  if (result.error) {
    const info = context.dump(result.error); result.error.dispose();
    throw new Error(typeof info?.message === 'string' ? info.message : '程序执行失败');
  }
  const value = context.getString(result.value); result.value.dispose();
  if (value.length > 65536) throw new Error('返回内容超过 64 KB');
  parentPort.postMessage({ ok: true, value: workerData.validate ? null : JSON.parse(value) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error.message || error).slice(0, 600) });
} finally {
  context?.dispose(); runtime?.dispose();
}
