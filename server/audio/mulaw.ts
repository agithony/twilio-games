export const MULAW_SAMPLE_RATE = 8_000 as const;
export const MULAW_CHANNELS = 1 as const;

function decodeSample(value: number): number {
  const inverted = (~value) & 0xff;
  let magnitude = ((inverted & 0x0f) << 3) + 0x84;
  magnitude <<= (inverted & 0x70) >> 4;
  return (inverted & 0x80) !== 0 ? 0x84 - magnitude : magnitude - 0x84;
}

export const MULAW_DECODE_TABLE: Readonly<Int16Array> = (() => {
  const table = new Int16Array(256);
  for (let index = 0; index < table.length; index += 1) table[index] = decodeSample(index);
  return table;
})();

/** Decodes headerless 8 kHz mono G.711 mu-law bytes to signed 16-bit PCM. */
export function decodeMuLaw8kMono(payload: Uint8Array): Int16Array {
  if (!(payload instanceof Uint8Array)) throw new TypeError('mu-law payload must be a Uint8Array');
  const samples = new Int16Array(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    samples[index] = MULAW_DECODE_TABLE[payload[index]!]!;
  }
  return samples;
}
