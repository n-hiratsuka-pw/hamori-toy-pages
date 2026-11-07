// recorder-worklet.js — マイク入力を Float32 PCM のまま主スレッドへ送る AudioWorklet
// 128 サンプル単位で届くブロックをまとめて 2048 サンプルごとに postMessage する。

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(2048);
    this.fill = 0;
    this.active = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.active = false; };
  }
  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.chunk[this.fill++] = ch[i];
      if (this.fill === this.chunk.length) {
        this.port.postMessage(this.chunk);
        this.chunk = new Float32Array(2048);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
