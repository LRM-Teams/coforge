import { queryOptions, useQuery } from "@tanstack/react-query";

import { m } from "@/paraglide/messages";
import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";

import { loadConversationFiles, type ConversationFile } from "./conversation-files.functions";

export const conversationFilesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", "files", conversationId],
    queryFn: async () => (await loadConversationFiles({ data: { conversationId } })).files,
    staleTime: 0,
  });

export function useConversationFiles(conversationId: string) {
  return useQuery(conversationFilesQuery(conversationId));
}

function fileRow(file: ConversationFile) {
  return (
    <li
      key={file.id}
      className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
    >
      <a
        href={`/api/attachments/${file.id}`}
        className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        download
      >
        {file.fileName}
      </a>
      <span className="shrink-0 text-xs text-tertiary">{getReadableFileSize(file.sizeBytes)}</span>
      {file.sender && (
        <span className="hidden shrink-0 text-xs text-tertiary sm:inline">{file.sender}</span>
      )}
      <span className="shrink-0 text-xs text-tertiary">
        {new Date(file.createdAt).toLocaleDateString()}
      </span>
      <a
        href={`/api/attachments/${file.id}`}
        download
        className="shrink-0 text-xs text-brand hover:underline"
      >
        {m.files_download()}
      </a>
    </li>
  );
}

export function ConversationFilesPanel({
  conversationId,
  conversationName,
}: {
  conversationId: string;
  conversationName: string;
}) {
  const { data: files, isPending, isError } = useConversationFiles(conversationId);
  if (isPending) {
    return <p className="p-5 text-sm text-tertiary">{m.files_loading()}</p>;
  }
  if (isError) {
    return <p className="p-5 text-sm text-error-primary">{m.files_load_failed()}</p>;
  }
  if (!files || files.length === 0) {
    return (
      <div className="grid h-full place-content-center p-5 text-center">
        <p className="text-sm text-tertiary">{m.files_empty()}</p>
      </div>
    );
  }
  return (
    <section aria-label={m.files_title({ name: conversationName })} className="flex min-h-0 flex-1 flex-col bg-primary">
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <ul>{files.map(fileRow)}</ul>
      </div>
    </section>
  );
}
