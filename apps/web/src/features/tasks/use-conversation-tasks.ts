import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskCommand, TaskView } from "@coforge/protocol";
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

export function useConversationTasks(conversationId: string) {
  const execute = useServerFn(executeTask);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const conversationRef = useRef(conversationId);
  const previousConversationRef = useRef(conversationId);
  const refreshSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  conversationRef.current = conversationId;
  const refresh = useCallback(
    async (options?: { preserveError?: boolean }) => {
      const requestedConversation = conversationId;
      const refreshSequence = ++refreshSequenceRef.current;
      const mutationSequence = mutationSequenceRef.current;
      try {
        const result = await execute({
          data: { operation: "list", requestId: crypto.randomUUID(), conversationId },
        });
        if (
          conversationRef.current === requestedConversation &&
          refreshSequence === refreshSequenceRef.current &&
          mutationSequence === mutationSequenceRef.current
        ) {
          setTasks(result.tasks);
          if (!options?.preserveError) setError("");
        }
      } catch {
        if (conversationRef.current === requestedConversation && !options?.preserveError)
          setError(m.tasks_load_error());
      } finally {
        if (conversationRef.current === requestedConversation) setLoading(false);
      }
    },
    [conversationId, execute],
  );
  useEffect(() => {
    if (previousConversationRef.current !== conversationId) {
      previousConversationRef.current = conversationId;
      setTasks([]);
      setError("");
    }
    setLoading(true);
    void refresh();
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(visible, 30_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, [refresh]);
  const command = useCallback(
    async (input: Omit<TaskCommand, "requestId" | "conversationId"> & { requestId?: string }) => {
      setError("");
      try {
        const result = await execute({
          data: { ...input, requestId: input.requestId ?? crypto.randomUUID(), conversationId },
        });
        mutationSequenceRef.current += 1;
        if (conversationRef.current === conversationId)
          setTasks((current) => mergeTaskChanges(current, result.tasks));
        return result.tasks;
      } catch (cause) {
        setError(m.tasks_mutation_error());
        await refresh({ preserveError: true });
        throw cause;
      }
    },
    [conversationId, execute, refresh],
  );
  return { tasks, loading, error, refresh, command };
}
