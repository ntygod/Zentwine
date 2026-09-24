import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { ROOT, hash, toolchain, withLock } from "./environment.mjs";
import {
  assertLocalMode,
  checked,
  localEnvironment,
  LocalToolError,
} from "./process.mjs";
export const TOOLS = path.join(ROOT, ".zentwine", "tools");
export async function temporalBinary(directory = TOOLS) {
  const archive = path.join(directory, "temporal.tar.gz"),
    binary = path.join(directory, "temporal");
  for (const file of [archive, binary]) {
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw new LocalToolError("temporal_tool_missing");
  }
  if (hash(await fs.readFile(archive)) !== toolchain.temporal.archive_sha256)
    throw new LocalToolError("temporal_archive_mismatch");
  const probe = await fs.mkdtemp(path.join(directory, "verify-"));
  try {
    await checked("tar", ["-xzf", archive, "-C", probe, "temporal"], {
      env: localEnvironment(),
    });
    if (
      hash(await fs.readFile(binary)) !==
      hash(await fs.readFile(path.join(probe, "temporal")))
    )
      throw new LocalToolError("temporal_binary_mismatch");
    await fs.access(binary, constants.X_OK);
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
  return binary;
}
export async function prepareTools({ offline = false, signal } = {}) {
  assertLocalMode();
  if (process.arch !== toolchain.architecture)
    throw new LocalToolError("unsupported_tool_architecture");
  return withLock(TOOLS, async () => {
    try {
      return {
        status: "verified",
        version: toolchain.temporal.version,
        binary: await temporalBinary(),
      };
    } catch (error) {
      if (offline || error.code !== "temporal_tool_missing") throw error;
    }
    const stage = await fs.mkdtemp(path.join(TOOLS, "install-"));
    try {
      const archive = path.join(stage, "temporal.tar.gz");
      await checked(
        "curl",
        [
          "--fail",
          "--location",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "--max-time",
          "120",
          "--output",
          archive,
          toolchain.temporal.archive_url,
        ],
        { signal, timeoutMs: 130000 },
      );
      if (
        hash(await fs.readFile(archive)) !== toolchain.temporal.archive_sha256
      )
        throw new LocalToolError("temporal_archive_mismatch");
      await checked("tar", ["-xzf", archive, "-C", stage, "temporal"], {
        signal,
      });
      await fs.chmod(path.join(stage, "temporal"), 0o700);
      await fs.rename(archive, path.join(TOOLS, "temporal.tar.gz"));
      await fs.rename(
        path.join(stage, "temporal"),
        path.join(TOOLS, "temporal"),
      );
      return {
        status: "installed_and_verified",
        version: toolchain.temporal.version,
        binary: await temporalBinary(),
      };
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  });
}
