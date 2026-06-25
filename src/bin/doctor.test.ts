import { test, expect } from "bun:test";
import { runDoctorChecks, isUnderTmp, parseClaudeAuthStatus, checkAuthSecurity, checkSigningSecurity, type DoctorCheck } from "./doctor";

test("isUnderTmp flags /tmp paths and accepts durable paths", () => {
  expect(isUnderTmp("/tmp")).toBe(true);
  expect(isUnderTmp("/tmp/para-raid-w7-data")).toBe(true);
  expect(isUnderTmp("/home/ubuntu/.local/state/para-raid")).toBe(false);
  expect(isUnderTmp("/var/tmpfoo")).toBe(false);
});

test("parseClaudeAuthStatus passes when logged in", () => {
  const r = parseClaudeAuthStatus(
    JSON.stringify({ loggedIn: true, email: "a@b.com", subscriptionType: "max" }),
    true
  );
  expect(r.pass).toBe(true);
  expect(r.msg).toContain("a@b.com");
});

test("parseClaudeAuthStatus fails when not logged in", () => {
  expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }), true).pass).toBe(false);
});

test("parseClaudeAuthStatus fails when the command errored or output is unparseable", () => {
  expect(parseClaudeAuthStatus("", false).pass).toBe(false);
  expect(parseClaudeAuthStatus("not json", true).pass).toBe(false);
});

test("checkAuthSecurity allows mode none and bearer with a strong token", () => {
  expect(checkAuthSecurity({ mode: "none" }).pass).toBe(true);
  expect(checkAuthSecurity({ mode: "bearer", token: "0123456789abcdef0123456789abcdef" }).pass).toBe(true);
  // strong, non-sentinel per-adapter tokens pass too
  expect(checkAuthSecurity({ mode: "bearer", token: "0123456789abcdef0123456789abcdef" },
    { uxie: { token: "fedcba9876543210fedcba9876543210" } }).pass).toBe(true);
});

test("checkAuthSecurity refuses a weak per-adapter token or an adapter named like the admin sentinel", () => {
  const strong = "0123456789abcdef0123456789abcdef";
  expect(checkAuthSecurity({ mode: "bearer", token: strong }, { uxie: { token: "short" } }).pass).toBe(false);
  expect(checkAuthSecurity({ mode: "bearer", token: strong }, { __admin__: { token: strong } }).pass).toBe(false);
});

test("checkAuthSecurity refuses bearer with a missing, short or whitespace-only token", () => {
  expect(checkAuthSecurity({ mode: "bearer", token: "" }).pass).toBe(false);
  expect(checkAuthSecurity({ mode: "bearer", token: "short" }).pass).toBe(false);
  expect(checkAuthSecurity({ mode: "bearer" }).pass).toBe(false);
  expect(checkAuthSecurity({ mode: "bearer", token: "                " }).pass).toBe(false);
});

test("checkAuthSecurity refuses mtls because it is not implemented", () => {
  const r = checkAuthSecurity({ mode: "mtls" });
  expect(r.pass).toBe(false);
  expect(r.msg).toContain("mtls");
});

test("checkSigningSecurity allows none/hmac-with-secret, refuses hmac without a real secret", () => {
  expect(checkSigningSecurity({ mode: "none" }).pass).toBe(true);
  expect(checkSigningSecurity({ mode: "hmac", secret: "0123456789abcdef0123456789abcdef" }).pass).toBe(true);
  expect(checkSigningSecurity({ mode: "hmac", secret: "" }).pass).toBe(false);
  expect(checkSigningSecurity({ mode: "hmac" }).pass).toBe(false);
  expect(checkSigningSecurity({ mode: "hmac", secret: "                " }).pass).toBe(false);
});

test("doctor reports each check with pass/fail/msg", async () => {
  const fakeChecks: DoctorCheck[] = [
    { name: "alpha", run: async () => ({ pass: true,  msg: "ok" }) },
    { name: "beta",  run: async () => ({ pass: false, msg: "missing" }) },
  ];
  const result = await runDoctorChecks(fakeChecks);
  expect(result.allPass).toBe(false);
  expect(result.checks).toEqual([
    { name: "alpha", pass: true,  msg: "ok" },
    { name: "beta",  pass: false, msg: "missing" },
  ]);
});

test("doctor allPass is true when all pass", async () => {
  const result = await runDoctorChecks([
    { name: "x", run: async () => ({ pass: true, msg: "" }) },
  ]);
  expect(result.allPass).toBe(true);
});
