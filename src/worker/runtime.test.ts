import { test, expect } from "bun:test";
import { interruptLine, parseClaudeLine, userMessageLine } from "./runtime";

const SID = "11111111-1111-4111-8111-111111111111";

test("parseClaudeLine maps system/init to an init event", () => {
  const ev = parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: SID, model: "claude-x", tools: ["Bash"], mcp_servers: [{ name: "scrypt", status: "connected" }] }), SID);
  expect(ev).toEqual({ type: "init", session_id: SID, model: "claude-x", tools: ["Bash"], mcp_servers: [{ name: "scrypt", status: "connected" }] });
});

test("parseClaudeLine keeps other system events with their raw payload", () => {
  const ev = parseClaudeLine(JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, error: "rate_limit" }), SID);
  expect(ev?.type).toBe("system");
  if (ev?.type === "system") {
    expect(ev.subtype).toBe("api_retry");
    expect(ev.raw.error).toBe("rate_limit");
  }
});

test("parseClaudeLine joins assistant text blocks and lists tool uses", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "Let me " },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      { type: "text", text: "look." },
    ] },
  });
  expect(parseClaudeLine(line, SID)).toEqual({
    type: "assistant", session_id: SID, text: "Let me look.",
    tool_uses: [{ id: "toolu_1", name: "Bash", input: { command: "ls" } }],
  });
});

test("parseClaudeLine normalises a success result", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FIRST OK", num_turns: 1, total_cost_usd: 0.002, duration_ms: 1704, stop_reason: "end_turn", terminal_reason: "completed", permission_denials: [] });
  expect(parseClaudeLine(line, SID)).toEqual({
    type: "result", session_id: SID, subtype: "success", is_error: false, result: "FIRST OK",
    num_turns: 1, total_cost_usd: 0.002, duration_ms: 1704, stop_reason: "end_turn", terminal_reason: "completed", permission_denials: [],
  });
});

test("parseClaudeLine treats an interrupted turn's missing result text as empty", () => {
  // What claude emits after a control_request/interrupt: is_error, no result string.
  const line = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, terminal_reason: "aborted_streaming", num_turns: 2 });
  const ev = parseClaudeLine(line, SID);
  expect(ev?.type).toBe("result");
  if (ev?.type === "result") {
    expect(ev.is_error).toBe(true);
    expect(ev.result).toBe("");
    expect(ev.terminal_reason).toBe("aborted_streaming");
    expect(ev.stop_reason).toBeUndefined();
  }
});

test("parseClaudeLine extracts the active window from a rate_limit_event", () => {
  const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: {
    status: "allowed", resetsAt: 1791453000, rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: 0.66, resetsAt: 1791453000 }, seven_day: { utilization: 0.1 } },
  } });
  expect(parseClaudeLine(line, SID)).toEqual({ type: "rate_limit", session_id: SID, status: "allowed", rate_limit_type: "five_hour", resets_at: 1791453000, utilization: 0.66 });
});

test("parseClaudeLine ignores user echoes, control responses and garbage", () => {
  expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }), SID)).toBeNull();
  expect(parseClaudeLine(JSON.stringify({ type: "control_response", response: {} }), SID)).toBeNull();
  expect(parseClaudeLine("not json", SID)).toBeNull();
  expect(parseClaudeLine("42", SID)).toBeNull();
});

test("userMessageLine and interruptLine produce the stdin wire format", () => {
  expect(JSON.parse(userMessageLine("hi\nthere"))).toEqual({
    type: "user", message: { role: "user", content: [{ type: "text", text: "hi\nthere" }] }, parent_tool_use_id: null,
  });
  expect(userMessageLine("x").endsWith("\n")).toBe(true);
  expect(JSON.parse(interruptLine("r1"))).toEqual({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
});
