import { queryOptions } from "@tanstack/react-query";

import { getLatestComputerVersion } from "./computers.functions";

/**
 * The newest released Computer version, asked for **after** the page renders.
 *
 * It is a read of the release feed — somebody else's server — so it stays off the routes' critical
 * path. Both Computers routes used to carry it in their loaders, which made every visit wait for a
 * third-party round trip (up to its 3 s timeout) before anything painted. It only decides whether
 * the upgrade badge shows, so the badge arriving a moment later is the right trade. The query also
 * dedupes and caches the value, so re-renders, route changes and the detail panel do not ask again;
 * the server side keeps its own short TTL cache in front of the feed.
 */
export const latestComputerVersionQuery = () =>
  queryOptions({
    queryKey: ["computers", "latest-version"],
    queryFn: () => getLatestComputerVersion(),
    staleTime: 5 * 60_000,
  });
