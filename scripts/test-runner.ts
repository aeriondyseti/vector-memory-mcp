#!/usr/bin/env bun
/**
 * Test runner wrapper that handles Bun's post-test crash gracefully.
 *
 * Bun crashes during native module cleanup after tests complete successfully.
 * This wrapper captures the output, verifies tests passed, and exits cleanly.
 */

import { spawn } from "bun";

// Exclude benchmark tests — they're probabilistic quality metrics, not pass/fail gates.
// Run benchmarks separately with: bun run benchmark
const args = ["bun", "test", "--preload", "./tests/preload.ts"];

// Collect all test files except benchmarks
const glob = new Bun.Glob("tests/**/*.test.ts");
for (const path of glob.scanSync(".")) {
  if (!path.includes("benchmark")) args.push(path);
}

const proc = spawn(args, {
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, FORCE_COLOR: "1" },
});

let stdout = "";
let stderr = "";

const decoder = new TextDecoder();

// Stream stdout in real-time
const stdoutReader = proc.stdout.getReader();
(async () => {
  while (true) {
    const { done, value } = await stdoutReader.read();
    if (done) break;
    const text = decoder.decode(value);
    stdout += text;
    process.stdout.write(text);
  }
})();

// Stream stderr in real-time
const stderrReader = proc.stderr.getReader();
(async () => {
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    const text = decoder.decode(value);
    stderr += text;
    process.stderr.write(text);
  }
})();

await proc.exited;

// Check if tests actually passed by looking for the summary line
const output = stdout + stderr;
const passMatch = output.match(/(\d+) pass/);
const failMatch = output.match(/(\d+) fail/);

const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

// Exit based on test results, not Bun's crash
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
} else if (passed > 0) {
  console.log(`\n✅ All ${passed} tests passed (ignoring Bun cleanup crash)`);
  process.exit(0);
} else {
  console.error("\n⚠️  Could not determine test results");
  process.exit(1);
}
