import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const sourceRoot = "src";
const sourceExtensions = new Set([".ts", ".tsx"]);

function sourceFiles(root = sourceRoot) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return sourceExtensions.has(path.extname(entry.name)) ? [target] : [];
  });
}

function collectPeopleLocalErrors(file, source = fs.readFileSync(file, "utf8")) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const calls = [];
  function walk(node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "PeopleLocalError") {
      calls.push({ file, node, tree });
    }
    ts.forEachChild(node, walk);
  }
  walk(tree);
  return calls;
}

function assertDescriptorOnlyCalls(overrides = new Map()) {
  const calls = sourceFiles().flatMap((file) => collectPeopleLocalErrors(file, overrides.get(file)));
  for (const { file, node, tree } of calls) {
    assert.equal(node.arguments?.length, 1, `${file}: PeopleLocalError must receive exactly one descriptor argument: ${node.getText(tree)}`);
    const descriptor = node.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(descriptor), `${file}: PeopleLocalError argument must be a descriptor object: ${node.getText(tree)}`);
    const key = descriptor.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(tree) === "key");
    assert.ok(key && ts.isStringLiteral(key.initializer), `${file}: PeopleLocalError descriptor must have a string-literal key: ${node.getText(tree)}`);
  }
  return calls;
}

test("all source PeopleLocalError constructors are descriptor-only", () => {
  assertDescriptorOnlyCalls();
});

test("all-source guard rejects a stale two-argument constructor mutation", () => {
  const file = "src/hooks/useUserManagement.ts";
  const original = fs.readFileSync(file, "utf8");
  const mutated = original.replace(
    'new PeopleLocalError({ key: "invitationSendFailed" })',
    'new PeopleLocalError({ key: "invitationSendFailed" }, "localized copy")',
  );
  assert.notEqual(mutated, original, "mutation fixture must alter a real constructor call");
  assert.throws(
    () => assertDescriptorOnlyCalls(new Map([[file, mutated]])),
    /must receive exactly one descriptor argument/,
  );
});
