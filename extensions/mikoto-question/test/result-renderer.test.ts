import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderRequestCall, renderRequestResult } from "../src/result-renderer.ts";
import type { RequestUserInputDetails } from "../src/types.ts";
import { coloredTheme, plainTheme, questions } from "./fixtures.ts";

const streaming = { argsComplete: false, executionStarted: false, isPartial: true };
const complete = { argsComplete: true, executionStarted: true, isPartial: false };

describe("request call rendering", () => {
  it("replaces partial text from successive snapshots and previews only question text", () => {
    const render = (args: unknown) => renderRequestCall(args, plainTheme, streaming).render(120);
    const header = render({});
    assert.equal(header.length, 1);
    const partial = "Which database";
    assert.ok(render({ questions: [{ question: partial }] }).join("\n").includes(partial));
    const first = render({ questions: [questions[0]] });
    assert.equal(first.length, 2);
    assert.equal(first.filter((line) => line.includes(partial)).length, 1);
    const both = render({ questions: [questions[0], { ...questions[1], question: "How should" }] });
    assert.equal(both.length, 3);
    assert.ok(both[1]!.includes(questions[0]!.question));
    assert.ok(both[2]!.includes("How should"));
    const full = render({ questions }).join("\n");
    for (const question of questions) {
      for (const excluded of [question.id, question.header, ...question.options.flatMap(
        (option) => [option.label, option.description],
      )]) {
        // IDs may also be ordinary words in the question itself.
        if (!questions.some((item) => item.question.includes(excluded))) {
          assert.ok(!full.includes(excluded));
        }
      }
    }
  });

  it("ignores malformed and empty fields while keeping valid siblings", () => {
    const header = renderRequestCall({}, plainTheme, streaming).render(80);
    for (const args of [
      undefined, null, [], 42, "input", {}, { questions: null }, { questions: {} },
      { questions: [null, [], 1, {}, { question: null }, { question: 4 }, { question: "" }, { question: " \n " }] },
    ]) {
      assert.deepEqual(renderRequestCall(args, plainTheme, streaming).render(80), header);
    }
    const lines = renderRequestCall(
      { questions: [null, { question: "Available text" }, { question: {} }] },
      plainTheme, streaming,
    ).render(80);
    assert.equal(lines.length, 2);
    assert.ok(lines[1]!.includes("Available text"));
  });

  it("removes previews at argument completion, execution start, and final results", () => {
    const args = { questions };
    const preview = renderRequestCall(args, plainTheme, streaming).render(120);
    assert.ok(preview.length > 1);
    for (const context of [
      { ...streaming, argsComplete: true },
      { ...streaming, executionStarted: true },
      { ...streaming, isPartial: false },
      complete,
    ]) {
      const lines = renderRequestCall(args, plainTheme, context).render(120);
      assert.equal(lines.length, 1);
      assert.deepEqual(lines, renderRequestCall({ questions: [] }, plainTheme, context).render(120));
      for (const question of questions) assert.ok(!lines.join("\n").includes(question.question));
    }
  });

  it("wraps Unicode and multiline previews within terminal width", () => {
    const question = "猫の種類 🐈\nChoose a companion ".repeat(6);
    const component = renderRequestCall({ questions: [{ question }] }, coloredTheme, streaming);
    for (const width of [3, 10, 40, 80]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(stripVTControlCharacters(lines.join("\n")).includes("猫"));
    }
  });
});

describe("request result rendering", () => {
  function result(details: RequestUserInputDetails) {
    return { content: [{ type: "text", text: JSON.stringify(details.response) }], details };
  }

  it("composes one count row with ordered questions, answers, and notes", () => {
    const note = "Prefer an embedded deployment.";
    const details: RequestUserInputDetails = {
      status: "answered",
      questions,
      response: { answers: {
        [questions[0]!.id]: { answers: [questions[0]!.options[0]!.label, `user_note: ${note}`] },
        [questions[1]!.id]: { answers: [questions[1]!.options[1]!.label] },
      } },
    };
    const call = renderRequestCall({ questions }, plainTheme, complete).render(120);
    const lines = renderRequestResult(result(details), { isPartial: false }, coloredTheme).render(120);
    assert.equal(call.length, 1);
    assert.match(stripVTControlCharacters(lines[0]!), /2\/2/);
    const plainLines = lines.map(stripVTControlCharacters);
    assert.equal(plainLines.filter((line) => line.includes("2/2")).length, 1);
    let previous = 0;
    for (const question of questions) {
      const index = plainLines.findIndex((line) => line.includes(question.question));
      assert.ok(index > previous);
      previous = index;
      assert.equal(plainLines.filter((line) => line.includes(question.question)).length, 1);
      const selected = details.response.answers[question.id]!.answers[0]!;
      assert.ok(lines.join("\n").includes(coloredTheme.fg("accent", selected)));
    }
    assert.ok(lines.join("\n").includes(coloredTheme.fg("accent", note)));
    assert.ok(!plainLines.join("\n").includes("user_note: "));
    assert.ok(plainLines[1]!.search(/\S/) > plainLines[0]!.search(/\S/));
    assert.ok(plainLines[2]!.search(/\S/) > plainLines[1]!.search(/\S/));
  });

  it("counts single, unanswered, partially answered, and empty results", () => {
    for (const [count, answered] of [[1, 1], [2, 0], [2, 1], [0, 0]] as const) {
      const items = questions.slice(0, count);
      const details: RequestUserInputDetails = {
        status: "answered", questions: items,
        response: { answers: Object.fromEntries(items.map((question, index) => [
          question.id, { answers: index < answered ? [question.options[0]!.label] : [] },
        ])) },
      };
      const lines = renderRequestResult(result(details), { isPartial: false }, plainTheme).render(120);
      assert.ok(lines[0]!.includes(`${answered}/${count}`));
      for (const question of items) assert.ok(lines.join("\n").includes(question.question));
      assert.equal(lines.length, 1 + count + answered);
    }
  });

  it("renders caller error text without successful details", () => {
    const error = "Caller-provided failure detail";
    const lines = renderRequestResult(
      { content: [{ type: "text", text: error }] }, { isPartial: false }, plainTheme,
    ).render(120);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes(error));
  });

  it("wraps long result data and hides answers for partial results", () => {
    const details: RequestUserInputDetails = {
      status: "answered",
      questions: [{ ...questions[0]!, question: "猫の種類\nChoose a companion ".repeat(5) }],
      response: { answers: {
        [questions[0]!.id]: { answers: ["Maine Coon 🐈 ".repeat(8), "user_note: first line\nsecond line"] },
      } },
    };
    const rendered = renderRequestResult(result(details), { isPartial: false }, coloredTheme);
    for (const width of [3, 10, 40, 80]) {
      assert.ok(rendered.render(width).every((line) => visibleWidth(line) <= width));
    }
    const partial = renderRequestResult(result(details), { isPartial: true }, plainTheme).render(120);
    assert.equal(partial.length, 1);
    assert.ok(!partial.join("\n").includes("Maine Coon"));
  });
});
