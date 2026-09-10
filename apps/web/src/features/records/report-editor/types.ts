/** Result returned by the host when uploading a pasted/dropped file. */
export type UploadResult = {
  id: string;
  link: string;
  markdownLink: string;
  fileName?: string;
  contentType?: string;
};
