import { useEffect, useRef, useState } from "react";
import type { TaskCommand, TaskView } from "@lrm/coforge-sdk/internal";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { useServerFn } from "@tanstack/react-start";

import { executeTask } from "./tasks.functions";
import { m } from "@/paraglide/messages";

export function mergeTaskChanges(current: TaskView[], changes: TaskView[]) {
  const changed = new Map(changes.map((task) => [task.messageId, task]));
  const merged = current.map((task) => {
    const replacement = changed.get(task.messageId);
    return replacement && replacement.revision >= task.revision ? replacement : task;
  });
  const known = new Set(current.map((task) => task.messageId));
  return [...merged, ...changes.filter((task) => !known.has(task.messageId))];
}

/** The Tasks of one conversation, re-read every 30 seconds while visible and on focus. */
export const conversationTasksQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", "tasks", conversationId],
    queryFn: async () =>
      (
        await executeTask({
          data: { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId },
        })
      ).tasks,
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

export function useConversationTasks(conversationId: string) {
  const queryClient = useQueryClient();
  const execute = useServerFn(executeTask);
  const query = useQuery(conversationTasksQuery(conversationId));
  const queryKey = conversationTasksQuery(conversationId).queryKey;
  const [mutationError, setMutationError] = useState("");
  // A failed command keeps its error on screen through the refetch it triggers; the next
  // successful read after that clears it, as any later read would.
  const holdErrorRef = useRef(false);
  useEffect(() => {
    if (!query.isSuccess) return;
    if (holdErrorRef.current) holdErrorRef.current = false;
    else setMutationError("");
  }, [query.isSuccess, query.dataUpdatedAt]);
  useEffect(() => {
    setMutationError("");
    holdErrorRef.current = false;
  }, [conversationId]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const command = async (
    input: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { idempotencyKey?: string },
  ) => {
    setMutationError("");
    try {
      const result = await execute({
        data: {
          ...input,
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          conversationId,
        },
      });
      // A list read that started before this command must not overwrite its result.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<TaskView[]>(queryKey, (current = []) =>
        input.operation === "delete" && input.number
          ? current.filter((task) => task.number !== input.number)
          : mergeTaskChanges(current, result.tasks),
      );
      return result.tasks;
    } catch (cause) {
      setMutationError(m.tasks_mutation_error());
      holdErrorRef.current = true;
      await queryClient.refetchQueries({ queryKey });
      throw cause;
    }
  };

  return {
    tasks: query.data ?? [],
    loading: query.isPending,
    error: mutationError || (query.isError ? m.tasks_load_error() : ""),
    refresh,
    command,
  };
}
