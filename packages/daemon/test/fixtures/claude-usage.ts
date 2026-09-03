const mode = process.argv.find((value) =>
  ["timeout", "logged-out", "parse-failure"].includes(value),
);
if (mode === "timeout") setInterval(() => {}, 1_000);
if (mode === "logged-out") {
  console.log(JSON.stringify({ loggedIn: false }));
} else if (process.argv[1]) {
  const isAuth = process.argv.includes("--json");
  if (isAuth) console.log(JSON.stringify({ loggedIn: true }));
  else
    console.log(
      mode === "parse-failure"
        ? "not usage data"
        : JSON.stringify({
            text: "Current session 25% used, resets Jan 2, 2027, 3:00pm (UTC)\nCurrent week 75% used, resets Jan 5, 2027, 12:00am (UTC)",
          }),
    );
}
