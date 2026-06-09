/**
 * SSRF guard for adapter-supplied webhook URLs. The intended adapter runs on
 * the same box, so loopback and private ranges stay allowed — only the
 * cloud-metadata / link-local ranges and non-http(s) schemes are rejected.
 * (DNS names that resolve into those ranges are not covered; see LIMITATIONS.)
 */
/** If host is an IPv4-mapped IPv6 literal (::ffff:a.b.c.d, or its compressed
 *  ::ffff:hhhh:hhhh form), return the embedded dotted-quad IPv4; else null.
 *  WHATWG normalizes ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, so both forms
 *  must be unwrapped before the range check or the metadata guard is bypassed. */
function mappedIpv4(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice(7);
  if (tail.includes(".")) return tail;
  const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isSafeWebhookUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = mappedIpv4(host) ?? host;
  if (v4.startsWith("169.254.")) return false; // IPv4 link-local incl. 169.254.169.254 metadata
  if (host.startsWith("fe80:")) return false;  // IPv6 link-local
  return true;
}
