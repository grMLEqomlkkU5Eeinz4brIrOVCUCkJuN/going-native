import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Minimal global sets (avoids pulling in the `globals` package).
const nodeGlobals = {
	process: "readonly",
	console: "readonly",
	Buffer: "readonly",
	globalThis: "readonly",
	__dirname: "readonly",
};
const jestGlobals = {
	describe: "readonly",
	test: "readonly",
	expect: "readonly",
	beforeAll: "readonly",
	afterAll: "readonly",
	beforeEach: "readonly",
	afterEach: "readonly",
};

export default tseslint.config(
	{
		ignores: ["dist/**", "build/**", "docs/**", "node_modules/**"],
	},
	// Sensible baselines layered in beneath the project's own rules.
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.{js,mjs,cjs,ts,tsx}"],
		languageOptions: {
			parser: tseslint.parser,
		},
		rules: {
			quotes: ["error", "double", { allowTemplateLiterals: true, avoidEscape: true }],
			indent: ["error", "tab"],
			"no-tabs": "off",
			"@typescript-eslint/no-var-requires": "off",
			// no-console stays off: the bench harness prints its results.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-unused-expressions": [
				"error",
				{ allowTernary: true },
			],
			"@typescript-eslint/explicit-function-return-type": [
				"warn",
				{ allowExpressions: true },
			],
		},
	},
	{
		// Node scripts (benchmark harness, TypeScript): Node globals, no
		// return-type noise.
		files: ["bench/**/*.ts"],
		languageOptions: { globals: nodeGlobals },
		rules: { "@typescript-eslint/explicit-function-return-type": "off" },
	},
	{
		// Jest test files (TypeScript): test + Node globals.
		files: ["test/**/*.ts"],
		languageOptions: { globals: { ...nodeGlobals, ...jestGlobals } },
		rules: { "@typescript-eslint/explicit-function-return-type": "off" },
	}
);
