import { queryOptions } from "@tanstack/react-query";
import {
  getProject,
  getProjectDirectoryCommits,
  getProjectObject,
  getProjectTree,
} from "./projects.functions";

export const projectQuery = (slug: string) =>
  queryOptions({
    queryKey: ["project", slug],
    queryFn: () => getProject({ data: { slug } }),
  });

/**
 * The whole default-branch tree, fetched once per visit. Folders expand from this cache, so
 * browsing sends no request until a file is opened. A stale refetch is a cheap 304 upstream.
 */
export const projectTreeQuery = (slug: string) =>
  queryOptions({
    queryKey: ["project", slug, "tree"],
    queryFn: () => getProjectTree({ data: { slug } }),
    staleTime: 60_000,
  });

/**
 * One file. With a blob `oid` from the tree the content is immutable, so it never goes stale
 * and revisiting a file costs nothing. Without one (truncated tree) the path reads `HEAD`.
 */
export const projectObjectQuery = (slug: string, path: string, oid?: string) =>
  queryOptions({
    queryKey: ["project", slug, "object", oid ?? `path:${path}`],
    queryFn: () => getProjectObject({ data: { slug, path, oid } }),
    // An outage or a revoked grant must not stick to an immutable key.
    staleTime: (query) =>
      oid && query.state.data?.status === "ready" ? Number.POSITIVE_INFINITY : 0,
    gcTime: 10 * 60_000,
  });

export const projectDirectoryCommitsQuery = (slug: string, path: string, treeSha: string) =>
  queryOptions({
    queryKey: ["project", slug, "commits", treeSha, path],
    queryFn: () => getProjectDirectoryCommits({ data: { slug, path } }),
    staleTime: 5 * 60_000,
  });
