/** Export the implemented schema and real in-process HTTP results; no model or external request. */
import fs from "node:fs/promises";
import {
  bootstrapSchema,
  errorSchema,
  CONTRACT_VERSION,
} from "../packages/contracts/dist/index.js";
import { buildApp } from "../services/api/dist/app.js";
const app = buildApp();
try {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/system/bootstrap",
    headers: { host: "127.0.0.1:4100" },
  });
  const error = await app.inject({
    method: "GET",
    url: "/api/v1/orgs/not-real/workspaces/none",
    headers: { host: "127.0.0.1:4100" },
  });
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile(
    "reports/runtime-contracts.json",
    JSON.stringify(
      {
        version: CONTRACT_VERSION,
        schemas: { bootstrap: bootstrapSchema, error: errorSchema },
        examples: { bootstrap: response.json(), error: error.json() },
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await app.close();
}
