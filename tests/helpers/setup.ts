import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// Tests build expected paths from os.tmpdir(), while the code reports canonical paths. On Windows
// runners the temp directory is an 8.3 short name (C:\Users\RUNNER~1\...), so canonicalize it once;
// os.tmpdir() reads these variables on every call, including in spawned child processes.
const canonical = realpathSync.native(tmpdir());
for (const name of process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"]) process.env[name] = canonical;
