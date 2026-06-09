// src/tmux/real.test.ts
import { test, expect } from "bun:test";
import { sendPrompt } from "./adapter";
import { createFakeTmux } from "./fake";

test("sendPrompt uses sendKeysLiteral for simple text", async () => {
  const tmux = createFakeTmux();
  await sendPrompt(tmux, "sess", "hello world");
  expect(tmux.calls[0].method).toBe("sendKeysLiteral");
  expect(tmux.calls[1].method).toBe("sendEnter");
});

test("sendPrompt uses loadBufferAndPaste for text with newlines", async () => {
  const tmux = createFakeTmux();
  await sendPrompt(tmux, "sess", "line1\nline2");
  expect(tmux.calls[0].method).toBe("loadBufferAndPaste");
  expect(tmux.calls[1].method).toBe("sendEnter");
});

test("sendPrompt uses loadBufferAndPaste for text > 8KB", async () => {
  const tmux = createFakeTmux();
  await sendPrompt(tmux, "sess", "x".repeat(9000));
  expect(tmux.calls[0].method).toBe("loadBufferAndPaste");
});
