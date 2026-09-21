import { queryOptions, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Clock, Download01, File01, MarkerPin01, XClose } from "@untitledui/icons";

import { m } from "@/paraglide/messages";
import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { formatDateForDisplay } from "@/lib/dates";

import { AttachmentPreview } from "./attachment-preview";
import { attachmentPreviewKind } from "./attachment-preview-kind";
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
  // The same preview rule a message attachment follows; `previewUrl` (signed) is what a PDF
  // needs, and images prefer it so the bytes skip the backend while the URL is fresh.
  const previewKind = attachmentPreviewKind(file.fileName, file.contentType, file.previewUrl);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const previewSrc = !previewFailed && file.previewUrl ? file.previewUrl : href;
  const handlePreviewError = () => {
    if (previewFailed || !file.previewUrl) setImgBroken(true);
    else setPreviewFailed(true);
  };
  const download = (
    <ButtonUtility
      icon={Download01}
      size="sm"
      color="secondary"
      tooltip={m.files_download()}
      href={`${href}?download`}
    />
  );
  // The whole card is the preview control, not just the thumbnail or the file name: a
  // full-card transparent trigger sits under the content, and the name/thumbnail pass clicks
  // through to it (pointer-events-none) while the corner actions stay clickable above it.
  const openPreview = isImage || Boolean(previewKind);
  const docPreviewKind = isImage ? null : previewKind;
  return (
    <li className="relative flex items-center gap-3 rounded-xl border border-secondary bg-primary p-3">
      {openPreview && (
        <DialogTrigger>
          <Button
            color="tertiary"
            noTextPadding
            aria-label={
              isImage
                ? file.fileName
                : m.conversation_attachment_preview_open({ name: file.fileName })
            }
            className="absolute inset-0 rounded-xl hover:bg-secondary"
          />
          {isImage ? (
            <ModalOverlay isDismissable>
              <Modal className="h-full w-full max-w-full bg-transparent shadow-none">
                <Dialog aria-label={file.fileName} className="h-full">
                  {({ close }) => {
                    // Same backdrop behavior as the message lightbox: pressing an overlay area
                    // itself (not the image or the actions) closes.
                    const dismissOnBackdrop = (event: React.PointerEvent) => {
                      if (event.target === event.currentTarget) close();
                    };
                    return (
                      <div className="flex h-full w-full flex-col">
                        <div
                          className="flex shrink-0 justify-end p-4"
                          onPointerDown={dismissOnBackdrop}
                        >
                          <div className="flex items-center gap-1 rounded-lg bg-primary/90 p-1 shadow-xs">
                            {download}
                            <ButtonUtility
                              icon={XClose}
                              size="sm"
                              color="tertiary"
                              tooltip={m.controls_close()}
                              onClick={close}
                            />
                          </div>
                        </div>
                        <div
                          className="flex min-h-0 flex-1 items-center justify-center"
                          onPointerDown={dismissOnBackdrop}
                        >
                          <img
                            src={previewSrc}
                            onError={handlePreviewError}
                            alt={file.fileName}
                            className="block max-h-full max-w-[min(96vw,80rem)] rounded-lg object-contain"
                          />
                        </div>
                      </div>
                    );
                  }}
                </Dialog>
              </Modal>
            </ModalOverlay>
          ) : (
            <ModalOverlay isDismissable>
              <Modal className="h-full max-h-full w-full max-sm:overflow-hidden sm:h-[85vh] sm:max-w-4xl">
                <Dialog aria-label={file.fileName} className="flex h-full flex-col overflow-hidden">
                  {({ close }) => (
                    <>
                      <div className="flex shrink-0 items-center gap-2 border-b border-secondary p-3 pl-4 sm:pl-5">
                        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                          {file.fileName}
                        </p>
                        {download}
                        <ButtonUtility
                          icon={XClose}
                          size="sm"
                          color="tertiary"
                          tooltip={m.controls_close()}
                          onClick={close}
                        />
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col">
                        <AttachmentPreview
                          fileName={file.fileName}
                          kind={docPreviewKind!}
                          href={href}
                          previewUrl={file.previewUrl}
                        />
                      </div>
                    </>
                  )}
                </Dialog>
              </Modal>
            </ModalOverlay>
          )}
        </DialogTrigger>
      )}
      {isImage ? (
        // The thumbnail prefers the signed CDN URL with the authenticated proxy as fallback
        // (and drops to the icon if both sources fail); clicking the card opens the lightbox.
        <div className="pointer-events-none relative shrink-0">
          {imgBroken ? (
            <span className="grid size-16 place-items-center rounded-lg ring-1 ring-secondary ring-inset">
              <File01 aria-hidden="true" className="size-6 text-fg-quaternary" />
            </span>
          ) : (
            <img
              src={previewSrc}
              onError={handlePreviewError}
              alt=""
              loading="lazy"
              className="size-16 rounded-lg object-cover ring-1 ring-secondary ring-inset"
            />
          )}
        </div>
      ) : (
        <div className="pointer-events-none relative grid size-16 shrink-0 place-items-center rounded-lg ring-1 ring-secondary ring-inset">
          <File01 aria-hidden="true" className="size-6 text-fg-quaternary" />
        </div>
      )}
      <div className="pointer-events-none relative min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-primary">{file.fileName}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-tertiary">
          <span className="tabular-nums">{getReadableFileSize(file.sizeBytes)}</span>
          <Clock aria-hidden="true" className="size-3.5" />
          <time dateTime={new Date(file.createdAt).toISOString()}>
            {formatDateForDisplay(file.createdAt, timeZone)}
          </time>
        </p>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1.5">
        {messageId && onOpenMessage && (
          <ButtonUtility
            icon={MarkerPin01}
            size="sm"
            color="secondary"
            tooltip={m.files_locate_message()}
            onClick={() => void onOpenMessage(messageId).catch(() => {})}
          />
        )}
        {download}
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
        className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 motion-safe:animate-pulse md:px-6"
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
    return <p className="p-4 text-sm text-destructive md:px-6">{m.files_load_failed()}</p>;
  }
  if (!files || files.length === 0) {
    return <p className="p-4 text-sm text-tertiary md:px-6">{m.files_empty()}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex flex-col gap-2 overflow-y-auto px-4 pt-4 pb-3 md:px-6">
        {files.map((file) => (
          <FileRow key={file.id} file={file} timeZone={timeZone} onOpenMessage={onOpenMessage} />
        ))}
      </ul>
    </div>
  );
}
