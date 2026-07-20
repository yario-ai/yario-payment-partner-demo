import { loadConfig } from "./config.js";
import { runConformance } from "./conformance.js";

try {
  const report = await runConformance(loadConfig());
  for (const check of report.checks) {
    const marker = check.status === "passed" ? "PASS" : check.status === "skipped" ? "SKIP" : "FAIL";
    console.log(`${marker.padEnd(4)} ${check.code}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  console.log(`\n${report.passed ? "Conformance passed" : "Conformance failed"}. Redacted JSON and JUnit reports were written.`);
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Conformance runner failed");
  process.exitCode = 1;
}
