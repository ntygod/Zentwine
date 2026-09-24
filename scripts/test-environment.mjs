/** Positive environment allowlist: do not forward model keys, database defaults or NODE_OPTIONS. */
export function isolatedTestEnvironment(source) {
  if (source.NODE_ENV && !["test", "development"].includes(source.NODE_ENV))
    throw new Error("Refusing tests in unsupported environment");
  const output = { NODE_ENV: "test", TZ: "UTC" };
  for (const key of [
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "CI",
    "ZENTWINE_TEST_DATABASE_URL",
    "ZENTWINE_TEST_DATABASE_ACK",
  ])
    if (typeof source[key] === "string") output[key] = source[key];
  return output;
}
