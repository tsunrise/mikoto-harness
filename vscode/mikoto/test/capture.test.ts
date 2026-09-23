import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEditor, createCapture } from "../src/capture";
import { contextResponse, RESPONSE_BYTES, TEXT_BYTES, validateSnapshot } from "../src/protocol";
import { editor, fakeAPI, Range } from "./helpers";

test("captures dirty text, normalized ranges, cursors, and terminal fallback without a text cache", () => {
  const e = editor("dirty 😀");
  e.value.selections.push(new Range({ line: 0, character: 2 }, { line: 0, character: 2 }));
  e.value.selections.push(new Range({ line: 0, character: 3 }, { line: 0, character: 1 }));
  const fake = fakeAPI(e);
  const capture = createCapture(fake.typed);
  assert.equal(capture.capture()?.selections[0].text, "dirty 😀");
  fake.change(undefined);
  const result = capture.capture()!;
  assert.equal(result.selections[1].text, "");
  assert.equal(result.selections[2].text, "ir");
  e.value.selections[0] = new Range({ line: 0, character: 1 }, { line: 0, character: 3 });
  assert.equal(capture.capture()?.selections[0].text, "ir");
  capture.dispose();
  assert.equal(fake.listeners(), 0);
});

test("ineligible editors clear the fallback; hidden and closed editors are not reused", () => {
  for (const kind of ["virtual", "outside", "hidden", "closed"]) {
    const fake = fakeAPI();
    const capture = createCapture(fake.typed);
    if (kind === "hidden") { fake.change(undefined); fake.hide(); }
    else if (kind === "closed") { fake.change(undefined); fake.close(); }
    else {
      const other = editor("secret", kind === "outside" ? "/elsewhere/file" : "/workspace/virtual");
      if (kind === "virtual") other.value.document.uri.scheme = "untitled";
      fake.change(other.value);
      assert.equal(capture.capture(), undefined);
      fake.change(undefined);
    }
    assert.equal(capture.capture(), undefined);
    capture.dispose();
  }
});

test("bounded chunks preserve surrogate pairs and cap giant single-line/multiple selections", () => {
  const source = "a".repeat(2047) + "😀" + "\0".repeat(100_000);
  const e = editor(source);
  for (let i = 0; i < 34; i++) e.value.selections.push(e.value.selections[0]);
  const fake = fakeAPI(e);
  const result = captureEditor(e.typed, "/workspace", fake.typed.Range);
  validateSnapshot(result);
  assert.equal(result.truncated, true);
  assert.equal(result.selections.length, 32);
  assert.ok(e.reads.every(size => size <= 2048));
  assert.ok(e.reads.length < 25);
  assert.ok(result.selections[0].text.startsWith("a".repeat(2047) + "😀"));
  assert.equal(Buffer.byteLength(result.selections[0].text), TEXT_BYTES);
  assert.equal(result.selections[1].text, "");
  const wire = contextResponse(result);
  assert.ok(Buffer.byteLength(wire) <= RESPONSE_BYTES);
  const fitted = validateSnapshot(JSON.parse(wire).context);
  assert.ok(source.startsWith(fitted.selections[0].text));
  assert.equal(fitted.truncated, true);
});

test("cursor-only snapshots never read document text", () => {
  const e = editor();
  e.value.selections = [new Range({ line: 0, character: 5 }, { line: 0, character: 5 })];
  const fake = fakeAPI(e);
  const snapshot = captureEditor(e.typed, "/workspace", fake.typed.Range);
  assert.equal(snapshot.selections[0].text, "");
  assert.deepEqual(e.reads, []);
});
