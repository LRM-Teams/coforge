import type { PrismaClient } from "#src/generated/prisma/client";
import { namePrefill } from "#src/features/auth/name-prefill";
import { checkPersonName, type PersonNameProblem } from "#src/features/profiles/person-name";
import {
  PrismaWorkspaceEnrollmentStore,
  WorkspaceEnrollment,
} from "#src/server/workspaces/enrollment.server";

/** Where a person's full name lives. */
export type FirstSignInNames = {
  /** The person's stored full name (null until they have been asked for one), or null when
   * there is no such person: a session can outlive its user. */
  lookup(userId: string): Promise<{ fullName: string | null } | null>;
  /** Stores `fullName` unless the person already has one; resolves with the name stored after. */
  setFullNameOnce(userId: string, fullName: string): Promise<string>;
};

export type NameStep =
  | { status: "named" }
  | { status: "ask"; prefill: string }
  /** The session's user is gone: the person has to sign in again. */
  | { status: "account_gone" };

export type FirstSignInResult =
  | { ok: true; workspaceId: string }
  | { ok: false; problem: PersonNameProblem };

/**
 * The step of first sign-in that asks a person for their full name: what the page needs to know
 * (`readNameStep`) and what submitting it does (`complete`): the name is saved, then the personal
 * Workspace is made, titled with it. Sign-in itself finishes without either; a person without a
 * name is sent here before anything is created for them.
 */
export class FirstSignIn {
  constructor(
    private readonly names: FirstSignInNames,
    private readonly enrollment: WorkspaceEnrollment,
  ) {}

  /** Whether to ask at all, and what the field starts with (the provider's own name, when it reads
   * as one). */
  async readNameStep(user: { id: string; name: string }): Promise<NameStep> {
    const person = await this.names.lookup(user.id);
    if (!person) return { status: "account_gone" };
    if (person.fullName !== null) return { status: "named" };
    return { status: "ask", prefill: namePrefill(user.name) };
  }

  /**
   * Saves the full name and makes the personal Workspace. Idempotent: the first name saved stays
   * (a second tab's, or a repeated submit, cannot replace it or retitle anything), and someone who
   * already has memberships gets them back as they are. `problem` says why a name was not accepted;
   * nothing is saved or created then.
   */
  async complete(input: {
    user: { id: string; username: string };
    fullName: string;
    acceptLanguage: string;
  }): Promise<FirstSignInResult> {
    const checked = checkPersonName(input.fullName);
    if (!checked.ok) return { ok: false, problem: checked.problem };
    const stored = await this.names.setFullNameOnce(input.user.id, checked.name);
    const { workspaceId } = await this.enrollment.ensureForUser(
      { id: input.user.id, username: input.user.username, fullName: stored },
      input.acceptLanguage,
    );
    return { ok: true, workspaceId };
  }
}

class PrismaFirstSignInNames implements FirstSignInNames {
  constructor(private readonly db: PrismaClient) {}

  lookup(userId: string) {
    return this.db.user.findUnique({ where: { id: userId }, select: { fullName: true } });
  }

  async setFullNameOnce(userId: string, fullName: string) {
    // One statement decides who was first, so two tabs cannot each believe theirs was saved.
    const { count } = await this.db.user.updateMany({
      where: { id: userId, fullName: null },
      data: { fullName },
    });
    if (count === 1) return fullName;
    const row = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { fullName: true },
    });
    return row.fullName ?? fullName;
  }
}

function firstSignIn(db: PrismaClient): FirstSignIn {
  return new FirstSignIn(
    new PrismaFirstSignInNames(db),
    new WorkspaceEnrollment(new PrismaWorkspaceEnrollmentStore(db)),
  );
}

export function readNameStep(input: {
  db: PrismaClient;
  user: { id: string; name: string };
}): Promise<NameStep> {
  return firstSignIn(input.db).readNameStep(input.user);
}

export function completeFirstSignIn(input: {
  db: PrismaClient;
  user: { id: string; username: string };
  fullName: string;
  acceptLanguage: string;
}): Promise<FirstSignInResult> {
  return firstSignIn(input.db).complete(input);
}
