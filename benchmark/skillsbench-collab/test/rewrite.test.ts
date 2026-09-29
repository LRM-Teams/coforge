import {
  collectExpectedPaths,
  replaceAbsPrefix,
  replaceAbsToken,
  rewriteInstruction,
  rewriteTestText,
} from "../src/rewrite";

describe("replaceAbsToken", () => {
  test("replaces a whole-token path and preserves the leading boundary", () => {
    // Ground truth from the OV evaluator's own regexes: a token match needs a
    // trailing boundary, so "/root/output" is left for the prefix pass.
    expect(replaceAbsToken('x = "/root"', "/root", "")).toBe('x = ""');
    expect(replaceAbsToken('open("/root/output/r.json")', "/root", "")).toBe(
      'open("/root/output/r.json")',
    );
  });

  test("leaves embedded occurrences without a boundary untouched", () => {
    expect(replaceAbsToken("x/root/y", "/root", "")).toBe("x/root/y");
  });
});

describe("replaceAbsPrefix", () => {
  test("replaces a path prefix keeping trailing content", () => {
    expect(replaceAbsPrefix("/root/sub/dir", "/root/", "./work/")).toBe("./work/sub/dir");
    expect(replaceAbsPrefix("a\n/root/data/f.csv\nb", "/root/", "")).toBe("a\ndata/f.csv\nb");
  });
});

describe("rewriteInstruction", () => {
  test("strips /root/ the way the OpenViking evaluator does", () => {
    const instruction =
      "Read /root/input/data.csv and write the result to /root/output/result.json.\nAlso see /rootly_file (unchanged).";
    const rewritten = rewriteInstruction(instruction);
    expect(rewritten).toContain("Read input/data.csv");
    expect(rewritten).toContain("write the result to output/result.json");
    expect(rewritten).toContain("/rootly_file");
  });
});

describe("rewriteTestText", () => {
  const options = { testsDirRelative: "tests", workDir: "/verify/dir" };

  test("maps the absolute roots onto the verify directory", () => {
    const rewritten = rewriteTestText(
      [
        "p = '/root/output/result.json'",
        'q = "/app/data/x.csv"',
        "assert os.path.exists('/workspace/note.md')",
      ].join("\n"),
      options,
    );
    // Ground truth verified against the OV evaluator's own Python functions:
    // /root/... and /app/... become bare relative paths via the prefix pass.
    expect(rewritten).toContain("p = 'output/result.json'");
    expect(rewritten).toContain('q = "data/x.csv"');
    expect(rewritten).toContain("exists('./workspace/note.md')");
  });

  test("rewrites /tests tokens and sys.path.insert lines", () => {
    const rewritten = rewriteTestText(
      [
        'sys.path.insert(0, "/tests/src")',
        'sys.path.insert(0, "/root")',
        "from /tests/helpers/x import y",
      ].join("\n"),
      options,
    );
    // The token pass consumes "/root" (trailing quote is a boundary), so the
    // later sys.path.insert literal rewrite never fires — same as upstream.
    expect(rewritten).toContain('sys.path.insert(0, "tests/src")');
    expect(rewritten).toContain('sys.path.insert(0, "")');
    expect(rewritten).toContain("from tests/helpers/x import y");
  });
});

describe("collectExpectedPaths", () => {
  test("collects root/app literals and drops directory tails", () => {
    const paths = collectExpectedPaths([
      `check("/root/output/result.json")`,
      `check('/app/data')`,
      `check("/app/data/")`,
    ]);
    expect(paths).toEqual(["/app/data", "/root/output/result.json"]);
  });
});
