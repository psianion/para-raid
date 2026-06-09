import { test, expect } from "bun:test";
import { createLogger, withRequestId, getRequestId } from "./index";

test("logs JSON with level and event", () => {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line), isTTY: false });
  log.info("test.event", { key: "val" });
  const parsed = JSON.parse(lines[0]);
  expect(parsed.level).toBe("info");
  expect(parsed.event).toBe("test.event");
  expect(parsed.key).toBe("val");
  expect(parsed.ts).toBeDefined();
});

test("propagates request_id via AsyncLocalStorage", async () => {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line), isTTY: false });
  await withRequestId("req-123", () => {
    log.info("inside", {});
    expect(getRequestId()).toBe("req-123");
  });
  const parsed = JSON.parse(lines[0]);
  expect(parsed.request_id).toBe("req-123");
});
