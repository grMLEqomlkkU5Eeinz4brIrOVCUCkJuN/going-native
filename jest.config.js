// Tests are written in TypeScript and run against the compiled ESM in dist/ +
// the native addon (loaded via createRequire). ts-jest transforms the .test.ts
// files to ESM in-memory; the dist/ import they pull in is already plain JS.
// Run with --experimental-vm-modules (wired in the npm "test" script).
export default {
	testEnvironment: "node",
	extensionsToTreatAsEsm: [".ts"],
	testMatch: ["**/test/**/*.test.ts"],
	// Integration-style tests (file/stream ingest, child-process parity) run in
	// parallel with ts-jest compile overhead; the default 5s is too tight under
	// load. 30s is generous headroom without masking real hangs.
	testTimeout: 30000,
	transform: {
		"^.+\\.ts$": [
			"ts-jest",
			{
				useESM: true,
				tsconfig: "tsconfig.test.json",
				// 151002: hybrid (nodenext) module advisory. We keep nodenext on
				// purpose so the dist ESM loads as in production and tests stay
				// type-checked; the advisory does not apply to these files.
				diagnostics: { ignoreCodes: [151002] },
			},
		],
	},
};
