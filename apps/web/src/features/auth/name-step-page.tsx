import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { submitFullName } from "#src/features/auth/first-sign-in.functions";
import { afterSignInHref } from "#src/features/auth/return-to";
import {
  checkPersonName,
  PERSON_NAME_MAX_LENGTH,
  type PersonNameProblem,
} from "#src/features/profiles/person-name";
import { m } from "#src/paraglide/messages";

type Problem = PersonNameProblem | "save_failed";

const problemText: Record<Problem, () => string> = {
  empty: () => m.welcome_error_empty(),
  too_long: () => m.welcome_error_too_long({ max: PERSON_NAME_MAX_LENGTH }),
  refused: () => m.welcome_error_refused(),
  save_failed: () => m.welcome_error_save_failed(),
};

/**
 * Where a signed-in person who has not been asked for a full name lands once, before anything is
 * created for them. Continuing saves the name, makes their personal Workspace, titled with it, and
 * goes on to `returnTo` (or the app's own start page).
 */
export function NameStepPage({
  prefill,
  returnTo,
}: {
  /** What the provider reported as the person's name, when it reads as one. */
  prefill: string;
  returnTo: string | undefined;
}) {
  const submit = useServerFn(submitFullName);
  const navigate = useNavigate();
  const [fullName, setFullName] = useState(prefill);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set at once, where `submitting` only changes on the next render: a second Enter in between
  // must not start a second save.
  const inFlight = useRef(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    // The server judges the name again; asking here first only spares a round trip.
    const checked = checkPersonName(fullName);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    inFlight.current = true;
    setSubmitting(true);
    const stop = (next: Problem) => {
      setProblem(next);
      setSubmitting(false);
      inFlight.current = false;
    };
    let result: Awaited<ReturnType<typeof submit>> | undefined;
    try {
      result = await submit({ data: { fullName } });
    } catch {
      return stop("save_failed");
    }
    // `useServerFn` resolves with nothing when the call redirected (the session is gone): the
    // router is already taking the person to sign in.
    if (!result) return;
    if (!result.ok) return stop(result.problem);
    // The name is saved, so a failure from here on is not a failed save. Stay busy through the
    // navigation: the page is replaced, not returned to.
    const destination = afterSignInHref(returnTo);
    try {
      await navigate({ href: destination });
    } catch {
      window.location.assign(destination);
    }
  }

  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="/logo.svg" alt="" className="size-12" />
          <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
            {m.welcome_title()}
          </h1>
        </div>
        <form noValidate onSubmit={onSubmit}>
          <Input
            label={m.welcome_full_name_label()}
            name="fullName"
            autoComplete="name"
            autoFocus
            value={fullName}
            onChange={(value) => {
              setFullName(value);
              setProblem(null);
            }}
            isInvalid={problem !== null}
            hint={problem ? <span role="alert">{problemText[problem]()}</span> : undefined}
          />
          <Button
            type="submit"
            size="lg"
            className="mt-6 w-full"
            isLoading={submitting}
            showTextWhileLoading
          >
            {m.welcome_continue()}
          </Button>
        </form>
      </div>
    </AuthSplitLayout>
  );
}
