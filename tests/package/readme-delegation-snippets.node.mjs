import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const REPOSITORY_ROOT = resolve(dirname(import.meta.filename), "../..");
const README_PATH = resolve(REPOSITORY_ROOT, "README.md");
const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

function typescriptCodeBlocks(markdown) {
	return [...markdown.matchAll(/```typescript\n([\s\S]*?)\n```/gu)].map(
		(match) => match[1],
	);
}

function property(object, name) {
	return object.properties.find(
		(candidate) =>
			ts.isPropertyAssignment(candidate) &&
			candidate.name
				.getText(object.getSourceFile())
				.replaceAll(/["']/gu, "") === name,
	);
}

function assertValidLiteralTarget(call, blockIndex) {
	const request = call.arguments[0];
	assert.ok(
		request !== undefined && ts.isObjectLiteralExpression(request),
		`README TypeScript block ${blockIndex} delegation request must be an object literal`,
	);
	const targetProperty = property(request, "target");
	assert.ok(
		targetProperty !== undefined &&
			ts.isObjectLiteralExpression(targetProperty.initializer),
		`README TypeScript block ${blockIndex} delegation request must carry an explicit target object`,
	);
	const target = targetProperty.initializer;
	const kindProperty = property(target, "kind");
	assert.ok(
		kindProperty !== undefined && ts.isStringLiteral(kindProperty.initializer),
		`README TypeScript block ${blockIndex} target.kind must be a string literal`,
	);
	if (kindProperty.initializer.text === "host") {
		assert.equal(
			target.properties.length,
			1,
			"host target must carry only kind",
		);
		return;
	}
	assert.equal(kindProperty.initializer.text, "worker");
	const nameProperty = property(target, "name");
	assert.ok(
		nameProperty !== undefined && ts.isStringLiteral(nameProperty.initializer),
		`README TypeScript block ${blockIndex} worker target needs a literal name`,
	);
	assert.match(nameProperty.initializer.text, WORKER_NAME_PATTERN);
	assert.equal(
		target.properties.length,
		2,
		"worker target must carry kind and name",
	);
}

test("every README TypeScript delegation has an explicit valid logical target", () => {
	const blocks = typescriptCodeBlocks(readFileSync(README_PATH, "utf8"));
	let delegationCount = 0;
	for (const [index, block] of blocks.entries()) {
		const source = ts.createSourceFile(
			`readme-block-${index}.ts`,
			block,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		function visit(node) {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				(node.expression.name.text === "delegate" ||
					node.expression.name.text === "delegateBatch")
			) {
				delegationCount += 1;
				assertValidLiteralTarget(node, index);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.ok(delegationCount > 0, "README must retain a delegation example");
});
