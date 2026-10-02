import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight } from "../site/highlight.js";

test("search highlights never match their own tags or escaped entities", () => {
  assert.equal(highlight("Mark & amp", "mark amp"), "<mark>Mark</mark> &amp; <mark>amp</mark>");
  assert.equal(highlight("cl_drawfps", "draw cl_drawfps"), "<mark>cl_drawfps</mark>");
  assert.equal(highlight("<img src=x> &", "img"), "&lt;<mark>img</mark> src=x&gt; &amp;");
  assert.equal(highlight("FOV fov", "fov fov"), "<mark>FOV</mark> <mark>fov</mark>");
  assert.equal(highlight("<none>", "how do i"), "&lt;none&gt;");
});
