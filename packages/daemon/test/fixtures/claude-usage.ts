const mode = process.argv.find((value) =>
  ["timeout", "logged-out", "parse-failure", "current", "username"].includes(value),
);
if (mode === "timeout") setInterval(() => {}, 1_000);
if (mode === "logged-out") {
  console.log(JSON.stringify({ loggedIn: false }));
} else if (process.argv[1]) {
  const isAuth = process.argv.includes("--json");
  if (isAuth)
    console.log(
      JSON.stringify({ loggedIn: mode !== "username" || Bun.env.USER === "usage-test-user" }),
    );
  else if (Bun.env.CLAUDE_USAGE_REPORT)
    console.log(JSON.stringify({ result: Bun.env.CLAUDE_USAGE_REPORT }));
  else if (mode === "current")
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result:
          Bun.env.TZ === "UTC"
            ? "Current session: 6% used · resets Sep 9 at 6:29am (UTC)\nCurrent week (all models): 0% used · resets Sep 16 at 4:59am (UTC)\nCurrent week (Fable): 1% used · resets Sep 16 at 4:59am (UTC)"
            : "Current session: 6% used · resets Sep 9 at 2:29pm (Asia/Shanghai)\nCurrent week (all models): 0% used · resets Sep 16 at 12:59pm (Asia/Shanghai)",
      }),
    );
  else
    console.log(
      mode === "parse-failure"
        ? "not usage data"
        : JSON.stringify({
            text: "Current session 25% used, resets Jan 2, 2027, 3:00pm (UTC)\nCurrent week 75% used, resets Jan 5, 2027, 12:00am (UTC)",
          }),
    );
}
