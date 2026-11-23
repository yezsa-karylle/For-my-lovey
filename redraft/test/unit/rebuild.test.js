import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixCase, cleanOcrText, dashPolyline, correctWord, learnWords, classifyPixel } from '../../src/js/io/rebuild.js';

test('fixCase lowers look-alike capitals but keeps acronyms and title lines', () => {
  assert.equal(fixCase('public health, soCial equity'), 'public health, social equity');
  assert.equal(fixCase('ACCess to Safe, affordable housing'), 'Access to safe, affordable housing');
  assert.equal(fixCase('not just the Structure -> also'), 'not just the structure -> also');
  assert.equal(fixCase('WHY WE STUDY HOUSING'), 'WHY WE STUDY HOUSING');
  assert.equal(fixCase('5. Guides Urban & Community Planning'), '5. Guides Urban & Community Planning');
  assert.equal(fixCase('2. Safety & Security'), '2. Safety & Security');
});

test('cleanOcrText normalises arrows, quotes and spaces', () => {
  assert.equal(cleanOcrText('space -) less  disease'), 'space -> less disease');
  assert.equal(cleanOcrText('people’s needs'), "people's needs");
});

test('correctWord snaps low-confidence look-alikes to words read confidently', () => {
  learnWords([{ text: 'housing', conf: 95 }, { text: 'housing', conf: 96 }, { text: 'basic', conf: 92 }, { text: 'basic', conf: 90 }]);
  assert.equal(correctWord('Howsing', 40), 'Housing');
  assert.equal(correctWord('bosic', 50), 'basic');
  assert.equal(correctWord('Howsing', 95), 'Howsing', 'confident words are left alone');
  assert.equal(correctWord('zebra', 30), 'zebra', 'no close match: unchanged');
  learnWords([{ text: 'family', conf: 95 }, { text: 'family', conf: 95 }]);
  assert.equal(correctWord('famiy', 92), 'family', 'a dropped thin letter is restored even when confident');
});

test('dashPolyline splits a line into dashes of the right length', () => {
  const d = dashPolyline([[0, 0], [100, 0]], 9, 8);
  assert.equal(d.length, 6);
  for (const dash of d.slice(0, -1)) assert.ok(Math.abs(dash[dash.length - 1][0] - dash[0][0] - 9) < 1e-6);
});

test('pixel classes match the notes palette', () => {
  const C = { none: 0, dark: 1, red: 2, blue: 3, yellow: 4, pink: 5 };
  assert.equal(classifyPixel(255, 255, 255), C.none);
  assert.equal(classifyPixel(194, 194, 194), C.none, 'grid line');
  assert.equal(classifyPixel(40, 40, 44), C.dark);
  assert.equal(classifyPixel(191, 60, 55), C.red);
  assert.equal(classifyPixel(45, 105, 200), C.blue);
  assert.equal(classifyPixel(249, 228, 102), C.yellow);
  assert.equal(classifyPixel(249, 160, 150), C.pink);
});
