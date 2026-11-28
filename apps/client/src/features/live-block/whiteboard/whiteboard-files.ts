import { uploadFile } from "@/features/page/services/page-service.ts";

export function dataUrlToFile(
  dataURL: string,
  name: string,
  mimeType: string,
): File {
  const [, base64 = ""] = dataURL.split(",", 2);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mimeType });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Stores a board image as an attachment of the page; returns its id. */
export async function uploadBoardImage(
  file: File,
  pageId: string,
): Promise<string> {
  const attachment = await uploadFile(file, { pageId });
  return attachment.id;
}

const ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A board's file references come from any editor: only an attachment uuid may reach a URL. */
export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_ID.test(value);
}

export async function loadBoardImage(attachmentId: string): Promise<string> {
  if (!isAttachmentId(attachmentId)) {
    throw new Error("Not an attachment id");
  }
  const res = await fetch(
    `/api/files/${encodeURIComponent(attachmentId)}/image`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw Object.assign(
      new Error(`Image ${attachmentId} could not be loaded`),
      {
        status: res.status,
      },
    );
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) {
    throw Object.assign(
      new Error(`Attachment ${attachmentId} is not an image`),
      {
        status: 415,
      },
    );
  }
  return blobToDataUrl(await res.blob());
}
