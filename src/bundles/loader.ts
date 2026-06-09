import { readFileSync } from "fs";
import { parse } from "smol-toml";
import { z } from "zod";

const ServerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), name: z.string(), url: z.string() }),
  z.object({ type: z.literal("sse"), name: z.string(), url: z.string() }),
  z.object({ type: z.literal("stdio"), name: z.string(), command: z.string(), args: z.array(z.string()).optional() }),
]);

const BundleSchema = z.object({
  name: z.string(),
  servers: z.array(ServerSchema).optional().default([]),
});

const BundlesFileSchema = z.object({
  bundles: z.array(BundleSchema),
});

export type Bundle = z.infer<typeof BundleSchema>;

export function loadBundles(path: string): Bundle[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw);
  const file = BundlesFileSchema.parse(parsed);
  return file.bundles;
}
