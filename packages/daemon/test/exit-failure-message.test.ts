import { describe, expect, test } from "bun:test";
import { exitFailureMessage } from "#src/code-agent/exit-failure-message";

describe("exitFailureMessage", () => {
  test("names the exit code and appends the stderr tail", () => {
    expect(exitFailureMessage({ exitCode: 3, stderrTail: "boom\n" })).toBe(
      "exit code 3 | stderr: boom",
    );
  });

  test("says 'terminated by signal' when there is no exit code", () => {
    expect(exitFailureMessage({ exitCode: null, stderrTail: "" })).toBe("terminated by signal");
    expect(exitFailureMessage({ exitCode: null, stderrTail: "SIGKILL" })).toBe(
      "terminated by signal | stderr: SIGKILL",
    );
  });

  test("trims each stderr line, drops the blank ones and joins the rest", () => {
    expect(exitFailureMessage({ exitCode: 1, stderrTail: "  first \n\n\t second  \n" })).toBe(
      "exit code 1 | stderr: first | second",
    );
  });

  test("handles CRLF tails and omits the separator when there is nothing to say", () => {
    expect(exitFailureMessage({ exitCode: 9, stderrTail: "one\r\ntwo\r\n" })).toBe(
      "exit code 9 | stderr: one | two",
    );
    expect(exitFailureMessage({ exitCode: 0, stderrTail: "  \n\t\n" })).toBe("exit code 0");
  });
});
