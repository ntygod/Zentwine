import { test as base, expect, type BrowserContext } from "@playwright/test";
/** Browser test tripwire, not a production sandbox. The application under test has no live keys. */
export async function restrictTestNetwork(
  context: BrowserContext,
): Promise<string[]> {
  const unexpected: string[] = [];
  const origins = new Set([
    "http://127.0.0.1:4100",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
  ]);
  await context.route("**/*", (route) => {
    if (origins.has(new URL(route.request().url()).origin))
      return route.continue();
    unexpected.push("non-local-request-blocked");
    return route.abort("blockedbyclient");
  });
  return unexpected;
}
export const test = base.extend({
  context: async ({ context }, use) => {
    const unexpected = await restrictTestNetwork(context);
    await use(context);
    expect(unexpected).toEqual([]);
  },
});
export { expect };
