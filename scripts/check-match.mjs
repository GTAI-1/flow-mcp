// Self-check for matchSent (how parallel image batches tie finished tiles to scenes): node scripts/check-match.mjs
import assert from "node:assert/strict";
import { matchSent } from "../dist/flow.js";

const a = "red apple on marble aaaaaaaa-1111-2222-3333-444444444444";
const b = "red apple on marble bbbbbbbb-1111-2222-3333-444444444444";
const c = "green pear on marble";
// Finished out of order, same prompt with different references, one scene at x2.
assert.deepEqual(matchSent([a, b, c], [c, b, a, c], [1, 1, 2]), [[2], [1], [0, 3]]);
// A tile whose stored prompt could not be read ("") is never handed to a scene; a lost scene gets nothing.
assert.deepEqual(matchSent([a, c], ["", c], [1, 1]), [[], [1]]);
// A reference whose picture carried no id at send time still matches on the words.
assert.deepEqual(matchSent(["green pear on marble"], ["green pear on marble cccccccc-1111-2222-3333-444444444444"], [1]), [[0]]);
// ...and the other way round: an id seen at send time but missing when the prompt is read back.
assert.deepEqual(matchSent([a], ["red apple on marble"], [1]), [[0]]);
console.log("matchSent ok");
