/** Test-only loader: pauses one actual file read to deliver a deterministic OS signal. */
import fs from "node:fs/promises";
const native = fs.open;
const action = process.env.ZT_INSPECTION_TEST_FAULT;
fs.open = async (...args) => {
  const handle = await native(...args);
  if (!String(args[0]).endsWith("producer-1.ndjson")) return handle;
  const read = handle.read.bind(handle);
  let first = true;
  handle.read = async (...input) => {
    if (first) {
      first = false;
      await new Promise((resolve) => {
        const done = () => {
          process.removeListener("SIGINT", done);
          process.removeListener("SIGTERM", done);
          if (process.connected) process.disconnect();
          resolve();
        };
        if (action === "deadline") setTimeout(done, 150);
        else {
          process.once("SIGINT", done);
          process.once("SIGTERM", done);
        }
        process.send?.("read_started");
      });
    }
    return read(...input);
  };
  return handle;
};
