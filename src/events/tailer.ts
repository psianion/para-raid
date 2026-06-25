import { watch } from "chokidar";
import { statSync, openSync, readSync, closeSync, writeFileSync } from "fs";
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
  // Ensure the file exists BEFORE chokidar watches it. Watching a not-yet-created
  // path means the first hook write lands as a chokidar `add` event (not
  // `change`), which we don't listen for — so the very first SessionStart would
  // never reach the bus and every real session would time out at launch. The
  // integration tests masked this by pre-creating the file. Append-mode create
  // never truncates an existing file (daemon restart keeps prior content).
  writeFileSync(filePath, "", { flag: "a" });

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
  // Re-scan once the watcher is armed: a hook can write in the window between
  // watch() returning and fsevents actually arming, and that first `change`
  // would otherwise be lost — which on the launch path means a missed
  // SessionStart and a session that times out. readNewLines is offset-based, so
  // calling it again is a no-op when there's nothing new.
  watcher.on("ready", readNewLines);

  return {
    stop() { return watcher.close(); },
  };
}
