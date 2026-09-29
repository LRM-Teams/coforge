import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { SettingsNavigationGroup } from "./settings-navigation-group";

export function SettingsPending() {
  return (
    <main aria-busy="true" className="flex h-svh min-w-0">
      <p role="status" className="sr-only">
        {m.settings_loading()}
      </p>
      <nav className="flex w-full min-w-0 flex-col overflow-hidden border-r border-secondary bg-primary md:w-60 md:shrink-0">
        <PageHeader heading={m.settings_title()} />
        <div className="space-y-5 overflow-y-auto p-3">
          {[
            {
              label: m.settings_personal_group(),
              items: [
                m.settings_account(),
                m.settings_language_region(),
                m.settings_preferences(),
                m.settings_notifications(),
                m.settings_integrations(),
              ],
            },
            {
              label: m.settings_workspace_group(),
              items: [m.settings_workspace_profile(), m.settings_members()],
            },
          ].map((group) => (
            <SettingsNavigationGroup key={group.label} label={group.label}>
              {group.items.map((label) => (
                <li key={label} className="flex h-9 items-center gap-3 px-3 text-sm font-medium">
                  <span>{label}</span>
                </li>
              ))}
            </SettingsNavigationGroup>
          ))}
        </div>
      </nav>
      <section className="@container/settings hidden min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex">
        <PageHeader heading={m.settings_account()} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          <section>
            <header className="flex min-h-12 items-center pb-4">
              <h2 className="text-lg font-semibold">{m.settings_profile()}</h2>
            </header>
            <div
              aria-hidden="true"
              className="space-y-6 border-t border-secondary py-6 motion-safe:animate-pulse"
            >
              <Skeleton className="size-20 rounded-full" />
              {["w-3/5", "w-4/5", "w-2/3"].map((width) => (
                <div
                  key={width}
                  className="grid gap-2 border-t border-secondary pt-5 @2xl/settings:grid-cols-[240px_minmax(0,1fr)] @2xl/settings:gap-8"
                >
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className={`h-4 ${width}`} />
                </div>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="grid gap-2 border-t border-secondary py-5 motion-safe:animate-pulse @2xl/settings:grid-cols-[240px_minmax(0,1fr)] @2xl/settings:gap-8"
            >
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
