import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegrated } from '../src/loudness.js';

test('parseIntegrated reads the EBU R128 summary', () => {
  const out = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:          -9.7 LUFS\n    Threshold: -20.1 LUFS\n';
  assert.equal(parseIntegrated(out), -9.7);
  assert.equal(parseIntegrated('  Integrated loudness:\n    I:         -70.0 LUFS'), null); // silence
  assert.equal(parseIntegrated('garbage'), null);
  assert.equal(parseIntegrated('  Integrated loudness:\n    I:           0.0 LUFS'), null); // filter failed (ffmpeg 5.1)
});
