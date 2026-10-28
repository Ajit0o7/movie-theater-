import assert from 'node:assert/strict';
import { test } from 'node:test';
import { popOutSize } from '../public/js/pip.js';

test('the pop-out opens at a 16:9 picture plus its control bar (and webcam strip when needed)', () => {
  assert.deepEqual(popOutSize(false, 1920), { width: 538, height: 349 });
  assert.deepEqual(popOutSize(true, 1920), { width: 538, height: 413 });
  assert.equal(popOutSize(false, 1000).width, 360, 'never tiny on a small screen');
  assert.equal(popOutSize(false, 3840).width, 560, 'never huge on a 4K screen');
});
