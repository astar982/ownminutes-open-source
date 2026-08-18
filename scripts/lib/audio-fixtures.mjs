export function buildSilentWav(sampleRate = 16_000, seconds = 1) {
  const dataBytes = sampleRate * seconds * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

export function buildToneWav(
  sampleRate = 16_000,
  seconds = 1,
  frequency = 440,
  amplitude = 0.15,
) {
  const output = buildSilentWav(sampleRate, seconds);
  const normalizedAmplitude = Math.max(0, Math.min(1, amplitude));
  const sampleCount = sampleRate * seconds;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequency * index) / sampleRate) *
      32_767 *
      normalizedAmplitude,
    );
    output.writeInt16LE(value, 44 + index * 2);
  }
  return output;
}
