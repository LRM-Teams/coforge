import { createContext, useContext, useState, type ReactNode } from "react";

const AssumedPhoneContext = createContext(false);

/**
 * What the server render (and the render that hydrates its markup) assumes about the viewport: a
 * phone, or a desktop. `useBreakpoint` and `useCoarsePointer` answer with it until the browser is
 * hydrated (see `requestIsFromPhone`).
 */
export function AssumedViewportProvider({
  phone,
  children,
}: {
  phone: boolean;
  children: ReactNode;
}) {
  // What the first render assumed, whatever the loader says later: in the browser it says no.
  const [assumed] = useState(phone);
  return <AssumedPhoneContext value={assumed}>{children}</AssumedPhoneContext>;
}

export function useAssumedPhone() {
  return useContext(AssumedPhoneContext);
}
