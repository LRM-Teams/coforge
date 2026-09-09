import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";

export function LoginPage({ error }: { error?: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-primary px-4 py-16 sm:px-6">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <div className="mb-6 flex size-12 items-center justify-center rounded-xl bg-brand-solid text-xl font-semibold text-white shadow-sm">
          C
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          {m.login_title()}
        </h1>
        <p className="mt-3 text-base leading-6 text-tertiary">{m.login_description()}</p>
        {error ? (
          <p
            role="alert"
            className="mt-6 w-full rounded-xl border border-error_subtle bg-error-primary p-4 text-left text-sm leading-5 text-error-primary"
          >
            {m.login_failed()}
          </p>
        ) : null}
        <Button href="/auth/login" size="lg" className="mt-8 w-full">
          {m.login_action()}
        </Button>
      </div>
    </main>
  );
}
