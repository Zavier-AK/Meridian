/** An image ready to send: base64 for the model, a data URL for the chat. */
export type ChatImage = { media_type: string; data: string; preview: string; name: string };

/** The model works from at most about this many pixels on the long edge; more costs
 * tokens without adding anything it can see. */
const MAX_EDGE = 1600;
/** Under the API's 5 MB per image, with room to spare. */
const MAX_BYTES = 4.5 * 1024 * 1024;
const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES = 6;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the image"));
    reader.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("that file isn't an image this can read"));
    img.src = url;
  });
}

function split(dataUrl: string): { media_type: string; data: string } {
  const [head, data] = dataUrl.split(",", 2);
  return { media_type: head.slice(5, head.indexOf(";")), data };
}

/**
 * Turn a pasted, dropped or chosen file into something the head agent can see. Small
 * enough images go as they are; bigger ones are scaled down (and a large PNG becomes a
 * JPEG) so a Retina screenshot doesn't spend thousands of tokens on pixels.
 */
export async function prepareImage(file: Blob, name = "image"): Promise<ChatImage> {
  if (!file.type.startsWith("image/")) throw new Error(`${name} isn't an image`);
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  if (SENDABLE.includes(file.type) && longEdge <= MAX_EDGE && file.size <= MAX_BYTES) {
    return { ...split(original), preview: original, name };
  }
  const scale = Math.min(1, MAX_EDGE / longEdge);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("couldn't prepare the image");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL("image/png");
  if (url.length * 0.75 > MAX_BYTES) url = canvas.toDataURL("image/jpeg", 0.88);
  if (url.length * 0.75 > MAX_BYTES) throw new Error(`${name} is too large to send`);
  return { ...split(url), preview: url, name };
}

/** The image files among what was pasted or dropped. */
export function imageFiles(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const entry of Array.from(list as ArrayLike<DataTransferItem | File>)) {
    const file = "getAsFile" in entry ? (entry.kind === "file" ? entry.getAsFile() : null) : entry;
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}
