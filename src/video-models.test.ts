import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateOmniFlash12Credits, isOmniFlash12, matchesModelLabel, OMNI_FLASH_12_DURATIONS } from "./video-models.js";

test("Omni 1.2 aliases match without accidentally choosing Omni 1.1", () => {
  assert.ok(matchesModelLabel("Gemini Omni 1.2 Flash", "Omni Flash 1.2"));
  assert.ok(matchesModelLabel("Omni Flash 1.2", "Omni 1.2 Flash"));
  assert.ok(!matchesModelLabel("Omni 1.1 Flash", "Omni Flash 1.2"));
  assert.ok(!isOmniFlash12("Omni Flash 1.1"));
  assert.ok(matchesModelLabel("Veo 3.1 - Lite", "Veo 3.1 - Lite"));
});

test("Omni 1.2 covers all second increments from 3 to 15", () => {
  assert.deepEqual(OMNI_FLASH_12_DURATIONS, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("Omni 1.2 estimates use the higher 11-15 second tier", () => {
  assert.equal(estimateOmniFlash12Credits(3, "360p"), 3);
  assert.equal(estimateOmniFlash12Credits(8, "720p"), 24);
  assert.equal(estimateOmniFlash12Credits(10, "720p"), 30);
  assert.equal(estimateOmniFlash12Credits(11, "360p"), 12);
  assert.equal(estimateOmniFlash12Credits(15, "360p"), 20);
  assert.equal(estimateOmniFlash12Credits(15, "720p"), 60);
  assert.throws(() => estimateOmniFlash12Credits(16, "720p"), RangeError);
});
