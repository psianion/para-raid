// src/tmux/real.test.ts
import { test, expect } from "bun:test";
import { sendPrompt } from "./adapter";
import { createFakeTmux } from "./fake";

// Readiness/verify polling interleaves capturePaneOutput calls; assert on the
// send calls only.
function sendCalls(tmux: ReturnType<typeof createFakeTmux>) {
  return tmux.calls.filter((c) => c.method !== "capturePaneOutput");
}

test("sendPrompt uses sendKeysLiteral for simple text", async () => {
  const tmux = createFakeTmux();
  await sendPrompt(tmux, "sess", "hello world");
  expect(sendCalls(tmux)[0].method).toBe("sendKeysLiteral");
  expect(sendCalls(tmux)[1].method).toBe("sendEnter");
});

test("sendPrompt uses loadBufferAndPaste for text with newlines", async () => {
  const tmux = createFakeTmux();
  await sendPrompt(tmux, "sess", "line1\nline2");
  expect(sendCalls(tmux)[0].method).toBe("loadBufferAndPaste");
  expect(sendCalls(tmux)[1].method).toBe("sendEnter");
});

test("sendPrompt uses loadBufferAndPaste for text > 8KB", async () => {
  const tmux = createFakeTmux();
  await sendPrompt(tmux, "sess", "x".repeat(9000));
  expect(sendCalls(tmux)[0].method).toBe("loadBufferAndPaste");
});

test("sendPrompt waits for the input prompt before sending", async () => {
  const tmux = createFakeTmux();
  tmux.paneOutput = "still booting..."; // no ❯ yet
  const p = sendPrompt(tmux, "sess", "hello");
  await new Promise((r) => setTimeout(r, 1200));
  expect(sendCalls(tmux).length).toBe(0); // nothing sent while not ready
  tmux.paneOutput = "❯ \n  bypass permissions on";
  await p;
  expect(sendCalls(tmux)[0].method).toBe("sendKeysLiteral");
});

test("promptStillPending: pending input line detected, submitted/echoed history ignored", async () => {
  const { promptStillPending } = await import("./adapter");
  const pending = "❯ hello there\n──────\n  bypass permissions on";
  expect(promptStillPending(pending, "hello there")).toBe(true);
  // after submit: echoed history line above, EMPTY input line below
  const submitted = "❯ hello there\n● Hi!\n──────\n❯ \n──────\n  bypass";
  expect(promptStillPending(submitted, "hello there")).toBe(false);
  expect(promptStillPending("no prompt lines at all", "hello")).toBe(false);
});
