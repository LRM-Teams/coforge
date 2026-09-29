import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { m } from "#src/paraglide/messages";
import { AuthSplitLayout } from "./auth-split-layout";
import { signInHref } from "./return-to";

/**
 * Where a sign-in that did not finish lands (`/login?error=…`): what happened and one way to try
 * again, back to the page it started from.
 */
export function LoginErrorPage({ returnTo }: { returnTo?: string }) {
  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="/logo.svg" alt="" className="size-12" />
          <div className="flex flex-col gap-2 md:gap-3">
            <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
              {m.login_error_title()}
            </h1>
            <HintText isInvalid role="alert" className="text-md">
              {m.login_failed()}
            </HintText>
          </div>
        </div>
        {/* A document navigation: /auth/login is a server route that hands off to Authing. */}
        <Button href={signInHref(returnTo)} size="lg" className="w-full">
          {m.login_retry()}
        </Button>
      </div>
    </AuthSplitLayout>
  );
}
