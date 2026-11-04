import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { ProjectContextError } from "../shared/errors.js";

export function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

export async function authorizeExistingPath(
  candidate: string,
  allowedRoots: string[],
  code: string,
  label: string,
): Promise<string> {
  const canonical = await realpath(resolve(candidate)).catch(() => {
    throw new ProjectContextError(`${code}_NOT_FOUND`, `${label} does not exist: ${candidate}`);
  });
  // Compare canonical forms on both sides: a root given as a Windows 8.3 short name
  // (C:\Users\RUNNER~1), a symlink or a junction must still contain its own files.
  const canonicalRoots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => resolve(root))));
  if (!canonicalRoots.some((root) => isWithinRoot(root, canonical))) {
    throw new ProjectContextError(code, `${label} is outside the configured allowed roots: ${canonical}`, {
      allowedRoots,
    });
  }
  return canonical;
}

export async function authorizeOutputPath(candidate: string, allowedRoots: string[]): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new ProjectContextError("INVALID_OUTPUT_PATH", "Output path must be absolute.");
  }
  const target = await canonicalizeForWrite(resolve(candidate));
  const canonicalRoots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => resolve(root))));
  if (!canonicalRoots.some((root) => isWithinRoot(root, target))) {
    throw new ProjectContextError("OUTPUT_PATH_NOT_ALLOWED", `Output path is outside the configured allowed roots: ${target}`, {
      allowedRoots,
    });
  }
  return target;
}

async function canonicalizeForWrite(target: string): Promise<string> {
  let existing = target;
  while (true) {
    try {
      const canonical = await realpath(existing);
      return resolve(canonical, relative(existing, target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}
