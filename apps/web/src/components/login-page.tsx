import { m } from "@/paraglide/messages";

export function LoginPage({ error }: { error?: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-16 sm:px-6">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <div className="mb-6 flex size-12 items-center justify-center rounded-xl bg-primary text-xl font-semibold text-primary-foreground shadow-sm">
          C
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{m.login_title()}</h1>
        <p className="mt-3 text-base leading-6 text-muted-foreground">{m.login_description()}</p>
        {error ? (
          <p
            role="alert"
            className="mt-6 w-full rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-left text-sm leading-5 text-destructive-text"
          >
            {m.login_failed()}
          </p>
        ) : null}
        <a
          href="/auth/login"
          className="mt-8 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-base font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.login_action()}
        </a>
      </div>
    </main>
  );
}
