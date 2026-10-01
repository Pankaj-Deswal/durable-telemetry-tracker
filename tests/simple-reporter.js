import path from "node:path";

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/** Prints: Filename\n- test: Passed|Failed */
export default class SimpleReporter {
  onTestResult(_test, testResult) {
    const file = path.basename(testResult.testFilePath);
    console.log(file);
    for (const t of testResult.testResults) {
      const status =
        t.status === "passed" ? green("Passed") : red("Failed");
      console.log(`- ${t.title}: ${status}`);
    }
    console.log("");
  }

  onRunComplete(_contexts, results) {
    const { numPassedTests, numFailedTests, numTotalTests } = results;
    console.log(
      `Summary: ${green(`${numPassedTests} passed`)}, ${red(`${numFailedTests} failed`)}, ${numTotalTests} total`,
    );
  }
}
