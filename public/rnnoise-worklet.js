// RNNoise AudioWorklet Processor
// AudioWorkletGlobalScope lacks importScripts/sync-XHR, so we fetch the WASM
// binary manually and pass it via Module['wasmBinary'] to bypass rnnoise-sync.js's
// synchronous loader (which only works in standard Worker contexts).
import createRNNWasmModuleSync from './rnnoise-sync.js';

const FRAME_SIZE = 480; // RNNoise requires exactly 480 samples at 48kHz

let rnn = null;
let denoiseState = null;
let inPtr = 0, outPtr = 0;
const inputBuf = [];
const outputBuf = [];

// Fetch WASM binary first (fetch() is available in AudioWorkletGlobalScope),
// then hand it to Emscripten as wasmBinary so the sync XHR path is never hit.
fetch('/rnnoise.wasm')
  .then(r => r.arrayBuffer())
  .then(wasmBinary => createRNNWasmModuleSync({ wasmBinary }))
  .then(module => module.ready.then(() => {
    rnn = module;
    denoiseState = rnn._rnnoise_create(0);
    inPtr  = rnn._malloc(FRAME_SIZE * 4);
    outPtr = rnn._malloc(FRAME_SIZE * 4);
  }))
  .catch(e => console.error('[RNNoise] WASM init failed:', e));

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bypass = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'bypass') this._bypass = data.value;
      if (data.type === 'ready?') this.port.postMessage({ type: 'ready', ok: !!(rnn && denoiseState) });
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!inp || !out) return true;

    // Passthrough if WASM not ready or bypassed
    if (!rnn || !denoiseState || this._bypass) {
      out.set(inp);
      return true;
    }

    // Buffer incoming samples
    for (let i = 0; i < inp.length; i++) inputBuf.push(inp[i]);

    // Process full 480-sample frames
    while (inputBuf.length >= FRAME_SIZE) {
      const inView = new Float32Array(rnn.HEAPF32.buffer, inPtr, FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) inView[i] = inputBuf[i] * 32768;
      inputBuf.splice(0, FRAME_SIZE);

      rnn._rnnoise_process_frame(denoiseState, outPtr, inPtr);

      const outView = new Float32Array(rnn.HEAPF32.buffer, outPtr, FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) outputBuf.push(outView[i] / 32768);
    }

    // Output processed samples; fall back to passthrough if buffer not full yet
    if (outputBuf.length >= out.length) {
      for (let i = 0; i < out.length; i++) out[i] = outputBuf.shift();
    } else {
      out.set(inp);
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
