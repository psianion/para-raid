import { watch } from "chokidar";
import { statSync, openSync, readSync, closeSync } from "fs";
import type { Db } from "../db";
import type { EventBus } from "./bus";
import type { HookEvent } from "../types";

export interface TailerOptions {
  /**
   * Force chokidar to use polling instead of inotify. Set this when watching
   * files on overlayfs / fuse / network mounts where inotify events do not
   * fire reliably. Defaults to false (use native inotify).
   */
  polling?: boolean;
}

export function startTailer(filePath: string, db: Db, bus: EventBus, opts: TailerOptions = {}) {
  const cursor = db.raw.query<{ file_inode: number; offset: number }, []>(
    "SELECT file_inode, offset FROM tailer_state WHERE id='singleton'"
  ).get();

  let currentInode = 0;
  let currentOffset = 0;

  try {
    const stat = statSync(filePath);
    currentInode = stat.ino;
    if (cursor && cursor.file_inode === currentInode) {
      currentOffset = cursor.offset;
    }
  } catch {
    // File doesn't exist yet — will be created when first hook fires
  }

  function readNewLines() {
    try {
      const stat = statSync(filePath);
      if (stat.ino !== currentInode) {
        currentInode = stat.ino;
        currentOffset = 0;
      }
      if (stat.size <= currentOffset) return;

      const fd = openSync(filePath, "r");
      const buf = Buffer.alloc(stat.size - currentOffset);
      readSync(fd, buf, 0, buf.length, currentOffset);
      closeSync(fd);

      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const event: HookEvent = JSON.parse(line);
          bus.emit(event);
        } catch {
          // Skip malformed lines
        }
      }

      currentOffset = stat.size;

      db.raw.run(
        `INSERT OR REPLACE INTO tailer_state (id, file_path, file_inode, offset, updated_at) VALUES ('singleton', ?, ?, ?, ?)`,
        [filePath, currentInode, currentOffset, Date.now()]
      );
    } catch {
      // File may not exist yet
    }
  }

  readNewLines();

  const watcher = watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    usePolling: opts.polling ?? false,
  });
  watcher.on("change", readNewLines);

  return {
    stop() { return watcher.close(); },
  };
}
