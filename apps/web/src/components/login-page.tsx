import { m } from "@/paraglide/messages";

export function LoginPage({ error }: { error?: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-6 flex size-10 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
          C
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{m.login_title()}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{m.login_description()}</p>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive-text">
            {m.login_failed()}
          </p>
        ) : null}
        <a
          href="/auth/login"
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {m.login_action()}
        </a>
      </div>
    </main>
  );
}
