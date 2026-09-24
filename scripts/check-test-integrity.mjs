/** Compare tests as syntax, never execute source from the base revision. */
import ts from "typescript";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isTestFile = (p) => /\.(test|spec)\.(mjs|[cm]?ts|tsx)$/.test(p);
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function inspectTests(source, name = "fixture.test.mjs") {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length)
    throw new Error("Test source does not parse");
  const printer = ts.createPrinter({ removeComments: true });
  const tests = new Map();
  const violations = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(file);
      // Includes Node's t.test and Playwright test.describe/test.skip forms.
      if (/^(?:test|it|describe|t\.test)(?:\.[A-Za-z]+)*$/.test(expression)) {
        if (/\.(skip|todo|only|fixme|fail)(\.|$)/.test(expression))
          violations.push("disabled_or_focused_test");
        if (node.arguments.length > 0) {
          const title = node.arguments[0];
          const callback = [...node.arguments].find(
            (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
          );
          if (callback) {
            const key = `${expression}:${printer.printNode(ts.EmitHint.Expression, title, file)}`;
            if (tests.has(key)) violations.push("duplicate_test_identity");
            tests.set(
              key,
              hash(printer.printNode(ts.EmitHint.Expression, node, file)),
            );
          }
          for (const argument of node.arguments) {
            if (ts.isObjectLiteralExpression(argument)) {
              for (const prop of argument.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  /^(skip|todo|only)$/.test(prop.name.getText(file))
                )
                  if (prop.initializer.kind !== ts.SyntaxKind.FalseKeyword)
                    violations.push("disabled_test_option");
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { tests, violations };
}
export function compareTests(before, after, name = "fixture.test.mjs") {
  const old = inspectTests(before, name);
  const next = inspectTests(after, name);
  const errors = [...old.violations, ...next.violations];
  for (const [id, digest] of old.tests) {
    if (!next.tests.has(id)) errors.push("required_test_removed");
    else if (next.tests.get(id) !== digest)
      errors.push("required_test_changed");
  }
  return errors;
}
export function checkTestIntegrity(root, base) {
  if (!/^[a-f0-9]{40}$/.test(base))
    throw new Error("Explicit base commit required");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
    });
  const prior = git(["ls-tree", "-r", "--name-only", "-z", base])
    .split("\0")
    .filter(isTestFile);
  const current = git(["ls-files", "-z"]).split("\0").filter(isTestFile);
  const errors = [];
  let protectedTests = 0;
  for (const name of prior) {
    const before = git(["show", `${base}:${name}`]);
    protectedTests += inspectTests(before, name).tests.size;
    if (!current.includes(name) || !fs.existsSync(path.join(root, name))) {
      errors.push({ path: name, rule: "required_test_file_removed" });
      continue;
    }
    for (const rule of compareTests(
      before,
      fs.readFileSync(path.join(root, name), "utf8"),
      name,
    ))
      errors.push({ path: name, rule });
  }
  for (const name of current) {
    for (const rule of inspectTests(
      fs.readFileSync(path.join(root, name), "utf8"),
      name,
    ).violations)
      errors.push({ path: name, rule });
  }
  return {
    status: errors.length ? "failed" : "passed",
    protected_files: prior.length,
    protected_test_declarations: protectedTests,
    errors,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = checkTestIntegrity(
      process.cwd(),
      process.argv[2] ??
        process.env.QUALITY_BASE_REF ??
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length ? 1 : 0;
  } catch {
    console.error(
      "Test integrity check could not establish a valid baseline; no tests were certified.",
    );
    process.exitCode = 1;
  }
}
