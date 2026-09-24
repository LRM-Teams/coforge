import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  EMPTY_TAB_ORDERS,
  PANEL_TABS,
  arrangeTabs,
  reorderTabs,
  type PanelTab,
  type TabOrderPanel,
  type TabOrders,
} from "./panel-tab-order";
import { savePanelTabOrder } from "./panel-tabs.functions";

type PanelTabOrderState = {
  orders: TabOrders;
  save: <P extends TabOrderPanel>(panel: P, order: PanelTab<P>[]) => void;
};

const PanelTabOrderContext = createContext<PanelTabOrderState>({
  orders: EMPTY_TAB_ORDERS,
  save: () => {},
});

type WorkspaceOrders = {
  workspaceId: string | undefined;
  /** What the strips show, including drops still being saved. */
  shown: TabOrders;
  /** What the server last confirmed; a failed save returns the strip to it. */
  confirmed: TabOrders;
};

type OrdersChange = (current: WorkspaceOrders) => WorkspaceOrders;

/** A state update that a save settling after a Workspace switch cannot apply to the new one. */
function inWorkspace(target: string | undefined, change: OrdersChange) {
  return (current: WorkspaceOrders) => (current.workspaceId === target ? change(current) : current);
}

type SaveRequest = {
  workspaceId: string | undefined;
  panel: TabOrderPanel;
  order: string[];
  request: number;
};

/**
 * The signed-in member's tab orders in the current Workspace, loaded with the app layout. A drop
 * shows the new order at once; saves share one mutation scope, so they run one at a time and the
 * last drop is the one kept ([TanStack Query: mutation scopes](https://tanstack.com/query/v5/docs/framework/react/guides/mutations#mutation-scopes)).
 * If the latest save fails, the strip returns to the last confirmed order. Layout reloads within
 * the same Workspace do not replace orders already shown or in flight; a Workspace switch does.
 */
export function PanelTabOrderProvider({
  workspaceId,
  orders: loaded,
  children,
}: {
  workspaceId: string | undefined;
  orders: TabOrders;
  children: ReactNode;
}) {
  const [state, setState] = useState<WorkspaceOrders>({
    workspaceId,
    shown: loaded,
    confirmed: loaded,
  });
  if (state.workspaceId !== workspaceId)
    setState({ workspaceId, shown: loaded, confirmed: loaded });

  const update = (target: string | undefined, change: OrdersChange) =>
    setState(inWorkspace(target, change));
  const saveOrder = useServerFn(savePanelTabOrder);
  const latest = useRef(0);
  const { mutate } = useMutation({
    scope: { id: "panel-tab-order" },
    mutationFn: ({ panel, order }: SaveRequest) => saveOrder({ data: { panel, order } }),
    onSuccess: (_saved, { workspaceId: target, panel, order }) =>
      update(target, (current) => ({
        ...current,
        confirmed: { ...current.confirmed, [panel]: order },
      })),
    onError: (_error, { workspaceId: target, panel, request }) => {
      if (latest.current !== request) return;
      update(target, (current) => ({
        ...current,
        shown: { ...current.shown, [panel]: current.confirmed[panel] },
      }));
    },
  });
  const save = useCallback(
    <P extends TabOrderPanel>(panel: P, order: PanelTab<P>[]) => {
      setState(
        inWorkspace(workspaceId, (current) => ({
          ...current,
          shown: { ...current.shown, [panel]: order },
        })),
      );
      mutate({ workspaceId, panel, order, request: ++latest.current });
    },
    [mutate, workspaceId],
  );
  const value = useMemo(() => ({ orders: state.shown, save }), [state.shown, save]);
  return <PanelTabOrderContext.Provider value={value}>{children}</PanelTabOrderContext.Provider>;
}

/**
 * One panel's visible tabs in the member's order, and the reorder handler for its strip.
 * `visible` lists the tabs this viewer may see, in default order.
 */
export function usePanelTabOrder<P extends TabOrderPanel>(
  panel: P,
  visible: readonly PanelTab<P>[],
) {
  const { orders, save } = useContext(PanelTabOrderContext);
  const saved: readonly PanelTab<P>[] = orders[panel];
  const all: readonly PanelTab<P>[] = PANEL_TABS[panel];
  return {
    tabs: arrangeTabs(visible, saved),
    reorder: (visibleOrder: PanelTab<P>[]) => save(panel, reorderTabs(all, saved, visibleOrder)),
  };
}
