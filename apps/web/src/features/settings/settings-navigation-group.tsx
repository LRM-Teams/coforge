export function SettingsNavigationGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="px-3 pt-2 pb-2 text-xs font-semibold text-quaternary uppercase tracking-wide">
        {label}
      </h2>
      <ul aria-label={label} className="space-y-1">
        {children}
      </ul>
    </div>
  );
}
