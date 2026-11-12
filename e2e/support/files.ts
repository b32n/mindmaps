import type { Page } from "@playwright/test";

/** A 1×1 PNG, as base64 and as bytes. */
export const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const PIXEL_PNG = Buffer.from(PIXEL_PNG_BASE64, "base64");

/**
 * Deliver an image to the page the way the browser does when something is
 * pasted: a real `paste` event whose clipboard carries a File. The app's own
 * handler does everything after that (upload, size, create the node).
 */
export async function pasteImage(page: Page, name = "pasted.png") {
  await page.evaluate(
    ([b64, fileName]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: "image/png" }));
      // a paste is delivered to whatever has focus
      (document.activeElement ?? document.body).dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    [PIXEL_PNG_BASE64, name],
  );
}

/** Drop an image file on a point of the page, as dragging it in from the desktop does. */
export async function dropImage(page: Page, at: { x: number; y: number }, name = "dropped.png") {
  await page.evaluate(
    ([b64, fileName, x, y]) => {
      const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName as string, { type: "image/png" }));
      const target = document.elementFromPoint(x as number, y as number)!;
      const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: x as number, clientY: y as number };
      target.dispatchEvent(new DragEvent("dragover", init));
      target.dispatchEvent(new DragEvent("drop", init));
    },
    [PIXEL_PNG_BASE64, name, at.x, at.y] as const,
  );
}
