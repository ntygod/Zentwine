/** Synthetic content, real disposable Git objects and real repository-compare CLI output. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(
  new URL("../../scripts/repository-compare.mjs", import.meta.url),
);
export async function createCommitReviewFixture(
  algorithm = "sha1",
  count = 12,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zt-review-"));
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  const git = (...args) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@zentwine.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    ).trim();
  try {
    git("init", "-q", "--initial-branch=main", `--object-format=${algorithm}`);
    await fs.mkdir(path.join(root, "src"));
    const body = Array.from({ length: count }, (_, i) => `context ${i}\n`).join(
      "",
    );
    await fs.writeFile(
      path.join(root, "src/example.ts"),
      `before\n${body}old end\n`,
    );
    await fs.writeFile(path.join(root, "binary.dat"), new Uint8Array([0, 1]));
    git("add", ".");
    git("commit", "-qm", "synthetic base");
    const base = git("rev-parse", "HEAD");
    await fs.writeFile(
      path.join(root, "src/example.ts"),
      `after\n${body}<img src="https://example.invalid/tripwire" onerror="globalThis.unsafeReview = true">\n\u202Econtrol\tline\r\nno final newline`,
    );
    await fs.writeFile(path.join(root, "binary.dat"), new Uint8Array([0, 2]));
    await fs.writeFile(path.join(root, "added.txt"), "new\n");
    git("add", ".");
    git("commit", "-qm", "synthetic head");
    const head = git("rev-parse", "HEAD");
    const compare = (selected, left = base, right = head) =>
      execFileSync(
        process.execPath,
        [
          cli,
          root,
          "--base",
          left,
          "--head",
          right,
          ...(selected ? ["--path", selected] : []),
        ],
        { encoding: "utf8", timeout: 10000 },
      );
    return {
      root,
      base,
      head,
      compare,
      listing: compare(),
      detail: compare("src/example.ts"),
      binary: compare("binary.dat"),
      empty: compare(null, base, base),
      cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
