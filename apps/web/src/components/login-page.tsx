import { Button } from "@/components/base/buttons/button";
import { HintText } from "@/components/base/input/hint-text";
import { m } from "@/paraglide/messages";

export function LoginPage({ error }: { error?: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-primary px-4 py-16 sm:px-6">
      <div className="flex w-full max-w-[360px] flex-col items-center text-center">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="size-10" />
          <span className="text-lg font-semibold text-primary">CoForge</span>
        </div>
        <h1 className="mt-6 text-display-xs font-semibold text-primary">{m.login_title()}</h1>
        <p className="mt-2 text-sm text-tertiary">{m.login_description()}</p>
        <Button href="/auth/login" size="lg" className="mt-8 w-full">
          {m.login_action()}
        </Button>
        {error ? (
          <HintText isInvalid className="mt-4" role="alert">
            {m.login_failed()}
          </HintText>
        ) : null}
      </div>
    </main>
  );
}
