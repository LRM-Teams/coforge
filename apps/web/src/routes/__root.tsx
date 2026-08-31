import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getLocale } from "@/paraglide/runtime";

import appCss from "../styles.css?url";

const themeScript = `try{var theme=localStorage.getItem("coforge-theme");if(theme==="dark"||((!theme||theme==="system")&&matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch{}`;

export const Route = createRootRoute({
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
        title: "CoForge",
      },
    ],
    links: [
      {
        rel: "icon",
        href: "/logo.svg",
        type: "image/svg+xml",
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
        <TooltipProvider>
          <div className="isolate">{children}</div>
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
