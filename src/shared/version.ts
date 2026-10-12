import { readFileSync } from "node:fs";

export const PACKAGE_VERSION = (JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string }).version;
