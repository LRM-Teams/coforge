import { expect, test } from "bun:test";
import { compareReleaseVersions, isValidReleaseVersion } from "./release-version";

test("accepts the release contract including prereleases and rejects path-like labels", () => {
  expect(isValidReleaseVersion("0.1.0-dev.15")).toBe(true);
  expect(isValidReleaseVersion("1.2.3-rc.1+build.7")).toBe(true);
  expect(isValidReleaseVersion("1.2")).toBe(false);
  expect(isValidReleaseVersion("1.2.3/evil")).toBe(false);
});

test("orders prereleases before stable versions and numeric identifiers numerically", () => {
  expect(compareReleaseVersions("1.0.0-dev.10", "1.0.0-dev.2")).toBeGreaterThan(0);
  expect(compareReleaseVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  expect(compareReleaseVersions("1.0.0", "1.0.0+build.1")).toBe(0);
});
