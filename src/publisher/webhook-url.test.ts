import { test, expect } from "bun:test";
import { isSafeWebhookUrl } from "./webhook-url";

test("allows http/https to ordinary, loopback and private hosts", () => {
  // The adapter is meant to run on the same box, so loopback/private stay allowed.
  expect(isSafeWebhookUrl("http://x/hook")).toBe(true);
  expect(isSafeWebhookUrl("https://example.com/hook")).toBe(true);
  expect(isSafeWebhookUrl("http://127.0.0.1:8080/h")).toBe(true);
  expect(isSafeWebhookUrl("http://10.0.0.5/h")).toBe(true);
});

test("blocks cloud-metadata and link-local addresses", () => {
  expect(isSafeWebhookUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  expect(isSafeWebhookUrl("http://169.254.1.2/h")).toBe(false);
  expect(isSafeWebhookUrl("http://[fe80::1]/h")).toBe(false);
});

test("blocks IPv4-mapped IPv6 literals that embed link-local/metadata", () => {
  expect(isSafeWebhookUrl("http://[::ffff:169.254.169.254]/")).toBe(false);
  expect(isSafeWebhookUrl("http://[::ffff:a9fe:a9fe]/h")).toBe(false);
  expect(isSafeWebhookUrl("http://[::ffff:169.254.0.1]/")).toBe(false);
});

test("still allows IPv4-mapped loopback (adapter may bind there)", () => {
  expect(isSafeWebhookUrl("http://[::ffff:127.0.0.1]/h")).toBe(true);
});

test("blocks non-http(s) schemes and unparseable URLs", () => {
  expect(isSafeWebhookUrl("file:///etc/passwd")).toBe(false);
  expect(isSafeWebhookUrl("ftp://x/h")).toBe(false);
  expect(isSafeWebhookUrl("not a url")).toBe(false);
  expect(isSafeWebhookUrl("")).toBe(false);
});
