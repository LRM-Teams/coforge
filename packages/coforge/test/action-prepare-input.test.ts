import { expect, test } from "bun:test";
import {
  ACTION_HEREDOC_DELIMITER,
  extractActionCardJson,
  parseActionCardInput,
} from "../src/action-prepare-input";
import { CliError } from "../src/cli-error";

test("ACTION_HEREDOC_DELIMITER is COFORGEACTION, not Raft's RAFTACTION", () => {
  expect(ACTION_HEREDOC_DELIMITER).toBe("COFORGEACTION");
});

test("extractActionCardJson strips a matching leading/trailing delimiter pair", () => {
  const raw = ["COFORGEACTION", '{"type":"channel:create","name":"design"}', "COFORGEACTION"].join(
    "\n",
  );
  expect(extractActionCardJson(raw)).toBe('{"type":"channel:create","name":"design"}');
});

test("extractActionCardJson tolerates trailing CRLF line endings on the delimiter lines", () => {
  const raw = [
    "COFORGEACTION\r",
    '{"type":"agent:create","name":"scout"}\r',
    "COFORGEACTION\r",
  ].join("\n");
  expect(extractActionCardJson(raw)).toBe('{"type":"agent:create","name":"scout"}');
});

test("extractActionCardJson returns raw JSON unchanged when there is no delimiter pair", () => {
  const raw = '{"type":"channel:create","name":"design"}';
  expect(extractActionCardJson(raw)).toBe(raw);
});

test("extractActionCardJson does not strip a single, unmatched delimiter line", () => {
  const raw = ["COFORGEACTION", '{"type":"channel:create","name":"design"}'].join("\n");
  expect(extractActionCardJson(raw)).toBe(raw);
});

test("parseActionCardInput parses a heredoc-wrapped body", () => {
  const raw = ["COFORGEACTION", '{"type":"agent:create","name":"scout"}', "COFORGEACTION"].join(
    "\n",
  );
  expect(parseActionCardInput(raw)).toEqual({ type: "agent:create", name: "scout" });
});

test("parseActionCardInput parses raw JSON with no delimiter", () => {
  expect(parseActionCardInput('{"type":"agent:create","name":"scout"}')).toEqual({
    type: "agent:create",
    name: "scout",
  });
});

test("parseActionCardInput throws MISSING_ACTION on empty stdin", () => {
  const error = (() => {
    try {
      parseActionCardInput("");
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("MISSING_ACTION");
  expect((error as CliError).message).toContain("coforge action prepare");
  expect((error as CliError).message).toContain(ACTION_HEREDOC_DELIMITER);
});

test("parseActionCardInput throws MISSING_ACTION when only whitespace is piped", () => {
  expect(() => parseActionCardInput("   \n  ")).toThrow(CliError);
});

test("parseActionCardInput throws MISSING_ACTION when the delimiter pair wraps nothing", () => {
  const raw = ["COFORGEACTION", "COFORGEACTION"].join("\n");
  const error = (() => {
    try {
      parseActionCardInput(raw);
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("MISSING_ACTION");
});

test("parseActionCardInput throws INVALID_JSON on malformed JSON", () => {
  const error = (() => {
    try {
      parseActionCardInput("{not json");
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("INVALID_JSON");
  expect((error as CliError).message).toContain("failed to parse");
});
