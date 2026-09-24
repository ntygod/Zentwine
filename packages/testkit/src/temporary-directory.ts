import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Deletes only this generated directory, never a caller-selected root. Not a code execution sandbox. */
export async function withTemporaryDirectory<T>(
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zentwine-fixture-"));
  const original = await lstat(directory);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await work(directory) };
  } catch (error) {
    outcome = { error };
  }
  try {
    const current = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (current) {
      if (
        current.isSymbolicLink() ||
        current.dev !== original.dev ||
        current.ino !== original.ino
      )
        throw new Error("Temporary fixture directory ownership changed");
      await rm(directory, { recursive: true, force: true });
    }
  } catch (cleanup) {
    if ("error" in outcome)
      throw new AggregateError(
        [outcome.error, cleanup],
        "Fixture body and cleanup failed",
      );
    throw cleanup;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
