import { queryOptions, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Clock, Download01, File01, MarkerPin01 } from "@untitledui/icons";

import { m } from "@/paraglide/messages";
import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateForDisplay } from "@/lib/dates";

import { loadConversationFiles, type ConversationFile } from "./conversation-files.functions";
import { attachmentUrl } from "./message-row";

const appRoute = getRouteApi("/_app");

export const conversationFilesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", "files", conversationId],
    queryFn: async () => (await loadConversationFiles({ data: { conversationId } })).files,
    staleTime: 0,
  });

export function useConversationFiles(conversationId: string) {
  return useQuery(conversationFilesQuery(conversationId));
}

function FileRow({
  file,
  timeZone,
  onOpenMessage,
}: {
  file: ConversationFile;
  timeZone: string | null;
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const href = attachmentUrl(file);
  const messageId = file.messageId;
  const isImage = file.inlineImage;
  return (
    <li className="flex items-center gap-3 rounded-xl border border-secondary bg-primary p-3">
      {isImage ? (
        // The authenticated proxy doubles as the thumbnail source; it is the same URL the
        // message bubble falls back to when no signed CDN preview exists.
        <img
          src={href}
          alt=""
          loading="lazy"
          className="size-16 shrink-0 rounded-lg object-cover ring-1 ring-secondary ring-inset"
        />
      ) : (
        <div className="grid size-16 shrink-0 place-items-center rounded-lg ring-1 ring-secondary ring-inset">
          <File01 aria-hidden="true" className="size-6 text-fg-quaternary" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-primary">{file.fileName}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-tertiary">
          <span className="tabular-nums">{getReadableFileSize(file.sizeBytes)}</span>
          <Clock aria-hidden="true" className="size-3.5" />
          <time dateTime={new Date(file.createdAt).toISOString()}>
            {formatDateForDisplay(file.createdAt, timeZone)}
          </time>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {messageId && onOpenMessage && (
          <ButtonUtility
            icon={MarkerPin01}
            size="sm"
            color="secondary"
            tooltip={m.files_locate_message()}
            onClick={() => void onOpenMessage(messageId).catch(() => {})}
          />
        )}
        <ButtonUtility
          icon={Download01}
          size="sm"
          color="secondary"
          tooltip={m.files_download()}
          href={`${href}?download`}
        />
      </div>
    </li>
  );
}

/** Card-shaped placeholder rows, in the real list's layout so nothing shifts when files land. */
function FilesSkeleton() {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="sr-only">
        {m.files_loading()}
      </p>
      <ul
        aria-hidden="true"
        className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 motion-safe:animate-pulse sm:px-6"
      >
        {["w-44", "w-56", "w-36"].map((nameWidth) => (
          <li
            key={nameWidth}
            className="flex items-center gap-3 rounded-xl border border-secondary bg-primary p-3"
          >
            <Skeleton className="size-16 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <Skeleton className={`h-4 ${nameWidth} max-w-2/3`} />
              <Skeleton className="mt-2 h-3 w-28" />
            </div>
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <Skeleton className="size-8 shrink-0 rounded-md" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConversationFilesPanel({
  conversationId,
  onOpenMessage,
}: {
  conversationId: string;
  /** Files-tab "locate in chat": switches to the chat view scrolled to the file's message. */
  onOpenMessage?: (messageId: string) => Promise<void>;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const { data: files, isPending, isError } = useConversationFiles(conversationId);
  if (isPending) {
    return <FilesSkeleton />;
  }
  if (isError) {
    return <p className="p-4 text-sm text-destructive">{m.files_load_failed()}</p>;
  }
  if (!files || files.length === 0) {
    return <p className="p-4 text-sm text-tertiary">{m.files_empty()}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 sm:px-6">
        {files.map((file) => (
          <FileRow key={file.id} file={file} timeZone={timeZone} onOpenMessage={onOpenMessage} />
        ))}
      </ul>
    </div>
  );
}
