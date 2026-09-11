import { Link } from "@tanstack/react-router";

import { m } from "@/paraglide/messages";

/** Child member report hanging under a template weekly-report node. */
export type TemplateChild = {
  id: string;
  title: string;
  status: string;
  author: {
    userId: string;
    username: string;
    displayName: string;
  };
};

/** One row in the template overview table (name filled first; other columns later). */
export type TemplateChildRow = {
  id: string;
  name: string;
};

/** Map template children to overview-table rows. Name comes from the child author. */
export function templateChildRows(children: readonly TemplateChild[]): TemplateChildRow[] {
  return children.map((child) => ({
    id: child.id,
    name: child.author.displayName,
  }));
}

export function TemplateChildrenTable({ children }: { children: readonly TemplateChild[] }) {
  const rows = templateChildRows(children);

  return (
    <div className="overflow-x-auto rounded-lg border border-secondary">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm text-primary">
        <thead>
          <tr className="border-b border-secondary">
            <th className="border-r border-secondary px-3 py-2 font-medium">
              {m.records_template_col_name()}
            </th>
            <th className="border-r border-secondary px-3 py-2 font-medium">
              {m.records_template_col_submitted()}
            </th>
            <th className="border-r border-secondary px-3 py-2 font-medium">
              {m.records_template_col_submit_time()}
            </th>
            <th className="px-3 py-2 font-medium">{m.records_template_col_key_points()}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="border-r border-secondary px-3 py-2 text-tertiary">&nbsp;</td>
              <td className="border-r border-secondary px-3 py-2" />
              <td className="border-r border-secondary px-3 py-2" />
              <td className="px-3 py-2" />
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-b border-secondary last:border-b-0">
                <td className="border-r border-secondary px-3 py-2">
                  <Link
                    to="/records/$recordId"
                    params={{ recordId: row.id }}
                    search={(previous) => ({
                      tab: previous.tab === "notes" ? "notes" : "weekly",
                    })}
                    className="text-primary hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="border-r border-secondary px-3 py-2" />
                <td className="border-r border-secondary px-3 py-2" />
                <td className="px-3 py-2" />
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
