import { describe, expect, test } from "bun:test";
import { redirect } from "@tanstack/react-router";

import { joinFailure } from "#src/features/workspaces/join-failure";
import { AppError } from "#src/lib/app-error";

describe("what a failed join means for the person on the invite page", () => {
  test("a redirect to sign-in means the session ended meanwhile", () => {
    expect(joinFailure(redirect({ href: "/login?returnTo=%2Fjoin%2Fabc" }))).toEqual({
      kind: "signed-out",
    });
  });

  test("a link that stopped working meanwhile is an invalid link", () => {
    expect(joinFailure(new AppError("NOT_FOUND"))).toEqual({ kind: "link-invalid" });
  });

  test("a server failure can be retried and carries its error reference", () => {
    expect(joinFailure(new AppError("INTERNAL_ERROR", { errorId: "e-1" }))).toEqual({
      kind: "server-error",
      errorId: "e-1",
    });
    expect(joinFailure(new AppError("TEMPORARILY_UNAVAILABLE"))).toEqual({
      kind: "server-error",
    });
  });

  test("a lost connection can be retried", () => {
    expect(joinFailure(new TypeError("Failed to fetch"))).toEqual({ kind: "unavailable" });
  });

  test("anything else can be retried too", () => {
    expect(joinFailure(new Error("RPC method failed"))).toEqual({ kind: "unavailable" });
    expect(joinFailure("nope")).toEqual({ kind: "unavailable" });
  });
});
