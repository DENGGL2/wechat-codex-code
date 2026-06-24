import { readFileSync } from 'node:fs';

export interface ScreenshotQuality {
  exists: boolean;
  bytes: number;
  validPng: boolean;
  width: number;
  height: number;
  distinctSampleColors: number;
  likelyBlank: boolean;
  visualEvidence: string;
}

export function inspectPngScreenshot(filePath: string): ScreenshotQuality {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return {
      exists: false,
      bytes: 0,
      validPng: false,
      width: 0,
      height: 0,
      distinctSampleColors: 0,
      likelyBlank: true,
      visualEvidence: 'file missing',
    };
  }

  const validPng = buf.length > 24
    && buf[0] === 0x89
    && buf[1] === 0x50
    && buf[2] === 0x4e
    && buf[3] === 0x47;
  const width = validPng ? buf.readUInt32BE(16) : 0;
  const height = validPng ? buf.readUInt32BE(20) : 0;

  const sample = new Set<string>();
  const step = Math.max(1, Math.floor(buf.length / 2048));
  for (let i = 0; i < buf.length; i += step) {
    sample.add(buf[i].toString(16).padStart(2, '0'));
  }

  const likelyBlank = !validPng
    || buf.length < 80_000
    || width < 600
    || height < 400
    || sample.size < 24;
  const visualEvidence = likelyBlank
    ? 'PNG metadata or byte sample still looks too simple; inspect the image before sending.'
    : 'PNG metadata is normal; final acceptance still requires visual inspection of the captured content.';

  return {
    exists: true,
    bytes: buf.length,
    validPng,
    width,
    height,
    distinctSampleColors: sample.size,
    likelyBlank,
    visualEvidence,
  };
}
