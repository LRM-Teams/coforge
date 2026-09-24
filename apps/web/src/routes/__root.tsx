import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";

import { AppToastProvider } from "#src/components/ui/toast";
import { getLocale } from "#src/paraglide/runtime";

import appCss from "#src/styles.css?url";

import { TASK_DISPLAY_FIELDS_BOOT } from "#src/features/settings/task-display-fields";
import { TASK_HIDDEN_COLUMNS_BOOT } from "#src/features/settings/task-hidden-columns";
const themeScript = `try{var theme=localStorage.getItem("coforge-theme");if(theme==="dark"||((!theme||theme==="system")&&matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark-mode")}if(localStorage.getItem("coforge-rail-labels")==="hide"){document.documentElement.classList.add("rail-labels-hidden")}if(localStorage.getItem("coforge-message-width")==="full"){document.documentElement.classList.add("message-full-width")}var textSizePercents={sm:"90%",lg:"110%",xl:"125%",xxl:"140%"};var textSize=localStorage.getItem("coforge-text-size");if(textSize&&textSizePercents[textSize]){document.documentElement.style.fontSize=textSizePercents[textSize]}${TASK_DISPLAY_FIELDS_BOOT}${TASK_HIDDEN_COLUMNS_BOOT}}catch{}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        name: "theme-color",
        content: "#101319",
      },
      {
        title: "CoForge",
      },
    ],
    links: [
      {
        rel: "icon",
        href: "/logo.svg?v=coforge-purple",
        type: "image/svg+xml",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "manifest",
        href: "/manifest.webmanifest",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        <AppToastProvider>
          <div className="isolate">{children}</div>
        </AppToastProvider>
        <Scripts />
      </body>
    </html>
  );
}
