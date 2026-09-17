import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choosePhoneFocus } from "../phoneConnectionFocus";
const node = (key: string, top: number, bottom: number, expanded = true) => ({
  key,
  top,
  bottom,
  expanded,
});
describe("choosePhoneFocus", () => {
  it("ignores folded cards and empty or hidden viewports", () => {
    assert.equal(
      choosePhoneFocus([node("closed", 0, 400, false)], 500, null),
      null,
    );
    assert.equal(choosePhoneFocus([], 500, "old"), null);
    assert.equal(choosePhoneFocus([node("a", 0, 900)], 0, null), null);
  });
  it("keeps a long expanded node focused after its title scrolls out", () => {
    assert.equal(
      choosePhoneFocus(
        [node("long", -900, 700), node("short", 710, 800)],
        500,
        "long",
      ),
      "long",
    );
  });
  it("switches to the expanded node that takes over the main viewing region", () => {
    assert.equal(
      choosePhoneFocus([node("a", -800, 160), node("b", 180, 750)], 500, "a"),
      "b",
    );
  });
  it("uses hysteresis rather than oscillating between similarly visible cards", () => {
    assert.equal(
      choosePhoneFocus([node("a", -50, 245), node("b", 250, 600)], 500, "a"),
      "a",
    );
  });
  it("hides previews when only headers or an edge sliver are visible", () => {
    assert.equal(
      choosePhoneFocus(
        [node("a", -800, 45), node("b", 70, 450, false)],
        500,
        "a",
      ),
      null,
    );
  });
});
