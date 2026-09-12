import fs from 'node:fs/promises';

// Read RIFF chunks rather than assuming a fixed 44-byte header.
export async function inspectWav(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Runtime did not produce a RIFF WAV file.');
    let format, audio;
    for (let offset = 12; offset + 8 <= size;) {
      const chunk = Buffer.alloc(8); await handle.read(chunk, 0, 8, offset);
      const name = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4);
      if (offset + 8 + length > size) throw new Error('Incomplete WAV output.');
      if (name === 'fmt ') {
        const body = Buffer.alloc(Math.min(length, 64)); await handle.read(body, 0, body.length, offset + 8);
        if (length < 16) throw new Error('Invalid WAV format chunk.');
        let code = body.readUInt16LE(0);
        if (code === 0xfffe && body.length >= 40) code = body.readUInt16LE(24);
        format = {code, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), blockAlign: body.readUInt16LE(12), bits: body.readUInt16LE(14)};
      }
      if (name === 'data') audio = {offset: offset + 8, length};
      offset += 8 + length + (length % 2);
    }
    if (!format || !audio || !audio.length || !format.channels || !format.sampleRate || !format.blockAlign) throw new Error('WAV output has no playable audio.');
    if (![1, 3].includes(format.code) || ![16, 24, 32].includes(format.bits)) throw new Error('Unsupported WAV sample format.');
    if (format.code === 3 && format.bits !== 32) throw new Error('Unsupported floating-point WAV format.');
    if (format.blockAlign !== format.channels * format.bits / 8 || audio.length % format.blockAlign !== 0) throw new Error('WAV output contains an incomplete sample frame.');
    const frames = Math.floor(audio.length / format.blockAlign), peaks = new Array(800).fill(0);
    const chunkSize = Math.floor((1024 * 1024) / format.blockAlign) * format.blockAlign;
    const buffer = Buffer.alloc(Math.min(chunkSize, audio.length));
    let squareSum = 0, sampleCount = 0, peak = 0;
    for (let pos = 0; pos < audio.length; pos += buffer.length) {
      const length = Math.min(buffer.length, audio.length - pos);
      const {bytesRead} = await handle.read(buffer, 0, length, audio.offset + pos);
      for (let local = 0; local + format.blockAlign <= bytesRead; local += format.blockAlign) {
        let framePeak = 0;
        for (let channel = 0; channel < format.channels; channel++) {
          const at = local + channel * format.bits / 8;
          let value = format.code === 3 ? buffer.readFloatLE(at) : format.bits === 16 ? buffer.readInt16LE(at) / 32768 : format.bits === 24 ? buffer.readIntLE(at, 3) / 8388608 : buffer.readInt32LE(at) / 2147483648;
          if (!Number.isFinite(value)) throw new Error('Runtime produced non-finite audio samples.');
          framePeak = Math.max(framePeak, Math.abs(value)); squareSum += value * value; sampleCount++;
        }
        peak = Math.max(peak, framePeak);
        const bucket = Math.min(799, Math.floor(((pos + local) / format.blockAlign) / frames * 800));
        peaks[bucket] = Math.max(peaks[bucket], Math.min(framePeak, 1));
      }
    }
    if (peak === 0) throw new Error('The runtime returned silent audio. Try a different prompt or seed.');
    return { duration: frames / format.sampleRate, sampleRate: format.sampleRate, channels: format.channels, peaks: peaks.map(p => Number(p.toFixed(5))), peak, rms: Math.sqrt(squareSum / sampleCount), bytes: size };
  } finally { await handle.close(); }
}
