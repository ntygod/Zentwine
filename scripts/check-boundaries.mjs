import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
export const rules = {
  "@zentwine/domain": [],
  "@zentwine/contracts": [],
  "@zentwine/config": [],
  "@zentwine/telemetry": ["@zentwine/contracts"],
  "@zentwine/client": ["@zentwine/contracts"],
  "@zentwine/testkit": ["@zentwine/domain"],
  "@zentwine/ui": ["@zentwine/client", "@zentwine/contracts", "react"],
  "@zentwine/api": [
    "@zentwine/contracts",
    "@zentwine/config",
    "@zentwine/telemetry",
    "fastify",
  ],
  "@zentwine/workbench": [
    "@zentwine/ui",
    "@zentwine/contracts",
    "react",
    "react-dom",
  ],
  "@zentwine/studio": [
    "@zentwine/ui",
    "@zentwine/contracts",
    "react",
    "react-dom",
  ],
};
function packageName(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}
export function inspectSource(owner, filename, source, packageRoot) {
  const errors = [];
  const check = (specifier) => {
    if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(filename), specifier);
      if (!target.startsWith(path.resolve(packageRoot) + path.sep))
        errors.push(`${owner}: cross-package relative import ${specifier}`);
      return;
    }
    if (
      specifier.startsWith("node:") &&
      ["@zentwine/api", "@zentwine/telemetry"].includes(owner)
    )
      return;
    if (!(rules[owner] ?? []).includes(packageName(specifier)))
      errors.push(`${owner}: forbidden dependency ${specifier}`);
  };
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) check(arg.text);
      else errors.push(`${owner}: computed module import is not permitted`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return errors;
}
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(dir, entry.name)]
          : [],
    );
}
export function checkBoundaries(root = process.cwd()) {
  const errors = [];
  const manifests = new Map();
  for (const top of ["apps", "services", "packages"]) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base)) {
      const location = path.join(base, dir);
      const manifest = path.join(location, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      manifests.set(pkg.name, pkg);
      if (!(pkg.name in rules)) {
        errors.push(`Missing dependency policy for ${pkg.name}`);
        continue;
      }
      for (const dependency of Object.keys(pkg.dependencies ?? {}))
        if (!rules[pkg.name].includes(dependency))
          errors.push(
            `${pkg.name}: forbidden manifest dependency ${dependency}`,
          );
      const src = path.join(location, "src");
      if (fs.existsSync(src))
        for (const file of files(src))
          errors.push(
            ...inspectSource(
              pkg.name,
              file,
              fs.readFileSync(file, "utf8"),
              location,
            ),
          );
    }
  }
  const done = new Set();
  const active = new Set();
  function visit(name) {
    if (active.has(name)) {
      errors.push(`Package dependency cycle at ${name}`);
      return;
    }
    if (done.has(name)) return;
    active.add(name);
    const pkg = manifests.get(name);
    for (const dep of Object.keys(pkg?.dependencies ?? {}))
      if (dep.startsWith("@zentwine/")) {
        if (!manifests.has(dep))
          errors.push(`Missing workspace dependency ${dep}`);
        else visit(dep);
      }
    active.delete(name);
    done.add(name);
  }
  for (const name of manifests.keys()) visit(name);
  return errors;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkBoundaries();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Workspace dependency boundaries and graph: PASS");
}
