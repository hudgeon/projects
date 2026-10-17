import React, { useEffect, useRef, useState } from "react";
import {
  SCREENSHOT_BYTES,
  SCREENSHOTS_PER_MESSAGE,
  type ScreenshotInput,
} from "./screenshot-model";

async function prepareScreenshot(file: Blob): Promise<ScreenshotInput> {
  if (
    ![
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
      "image/avif",
    ].includes(file.type) ||
    file.size > 20 * 1024 * 1024
  )
    throw Error(
      "Choose a photo or screenshot smaller than 20 MB. SVG files are not supported.",
    );
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = source;
  try {
    await image.decode();
  } catch {
    throw Error("This image format could not be opened. Choose a PNG or JPEG.");
  }
  if (
    !image.naturalWidth ||
    !image.naturalHeight ||
    image.naturalWidth * image.naturalHeight > 32_000_000
  )
    throw Error(
      "This image is too large. Choose a screenshot or crop it first.",
    );
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw Error("This browser could not prepare the screenshot.");
  let scale = Math.min(
    1,
    2400 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  // Re-encoding strips metadata and keeps a bounded upload. Prefer crisp PNG
  // when it fits; progressively resize a JPEG only when needed.
  for (let attempt = 0; attempt < 7; attempt++, scale *= 0.8) {
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const mime of ["image/png", "image/jpeg"] as const) {
      const url = canvas.toDataURL(mime, 0.88);
      const data = url.slice(url.indexOf(",") + 1);
      if (atob(data).length <= SCREENSHOT_BYTES)
        return { id: crypto.randomUUID(), mime, data };
    }
  }
  throw Error("The screenshot is too large. Crop it and try again.");
}

export function useScreenshots() {
  const [images, setImages] = useState<ScreenshotInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0),
    working = useRef(false);
  const currentImages = useRef(images);
  currentImages.current = images;
  const clear = () => {
    version.current++;
    setImages([]);
    setError("");
  };
  const add = async (files: Blob[]) => {
    if (working.current || !files.length) return;
    if (currentImages.current.length + files.length > SCREENSHOTS_PER_MESSAGE) {
      setError(`Add up to ${SCREENSHOTS_PER_MESSAGE} screenshots per message.`);
      return;
    }
    const current = version.current;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const prepared: ScreenshotInput[] = [];
      for (const file of files) prepared.push(await prepareScreenshot(file));
      if (current === version.current)
        setImages((previous) => [...previous, ...prepared]);
    } catch (failure) {
      if (current === version.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The screenshot could not be added.",
        );
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const paste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length) {
      event.preventDefault();
      void add(files);
    }
  };
  const fromClipboard = async () => {
    const current = version.current;
    try {
      if (!navigator.clipboard?.read) throw Error();
      // Call directly from the tap/click; Safari supplies its own Paste prompt.
      const items = await navigator.clipboard.read();
      const files: Blob[] = [];
      for (const item of items) {
        const type = item.types.find((value) => value.startsWith("image/"));
        if (type) files.push(await item.getType(type));
      }
      if (current !== version.current) return;
      if (!files.length) {
        setError(
          "No screenshot was found. Copy an image or choose Add screenshot.",
        );
        return;
      }
      await add(files);
    } catch {
      // iPhone Safari never offers Paste for an image in a text box's
      // touch-and-hold menu, so only this button's Paste prompt works there.
      if (current === version.current)
        setError(
          "Tap Paste again and allow it when asked, use ⌘V / Ctrl+V, or choose Add screenshot.",
        );
    }
  };
  return {
    images,
    busy,
    error,
    clear,
    add,
    paste,
    fromClipboard,
    remove: (id: string) =>
      setImages((previous) => previous.filter((image) => image.id !== id)),
  };
}

// A new preview pushes the message's buttons down: out of Today's own scrolling
// list, or behind a phone's keyboard while typing. Scroll just enough to show
// them again; scrollIntoView alone ignores the keyboard.
export function revealAction(action: Element | null | undefined) {
  if (!action) return;
  action.scrollIntoView({ block: "nearest" });
  const view = window.visualViewport;
  const bottom = view ? view.offsetTop + view.height : window.innerHeight;
  const hidden = action.getBoundingClientRect().bottom + 8 - bottom;
  if (hidden > 0) window.scrollBy({ top: hidden });
}
// Tapping these leaves the message box focused, so a phone keeps its keyboard
// and the page stays still while the browser asks to paste.
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

type Draft = { draft: ReturnType<typeof useScreenshots>; disabled: boolean };
// Buttons sit in the composer's action row; previews and errors above it.
export function ScreenshotButtons({ draft, disabled }: Draft) {
  const input = useRef<HTMLInputElement>(null);
  const limits = `Up to ${SCREENSHOTS_PER_MESSAGE} screenshots per message and 12 per conversation. You can also paste into the message.`;
  return (
    <>
      <button
        className="btn-quiet"
        type="button"
        title={limits}
        disabled={disabled || draft.busy}
        onMouseDown={keepFocus}
        onClick={() => input.current?.click()}
      >
        Add screenshot
      </button>
      <button
        className="btn-quiet"
        type="button"
        title={limits}
        disabled={disabled || draft.busy}
        onMouseDown={keepFocus}
        onClick={() => void draft.fromClipboard()}
      >
        Paste
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Choose screenshots"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void draft.add(files);
        }}
      />
    </>
  );
}
export function ScreenshotPreviews({ draft, disabled }: Draft) {
  const root = useRef<HTMLDivElement>(null);
  const count = draft.images.length,
    shown = useRef(count);
  useEffect(() => {
    if (count > shown.current)
      revealAction(
        root.current?.closest("form")?.querySelector('button[type="submit"]'),
      );
    shown.current = count;
  }, [count]);
  if (!draft.busy && !draft.error && !count) return null;
  return (
    <div className="screenshot-picker" ref={root}>
      {draft.busy && <p role="status">Preparing screenshot…</p>}
      {!!draft.error && (
        <p className="error" role="alert">
          {draft.error}
        </p>
      )}
      <div className="screenshot-previews">
        {draft.images.map((image, index) => (
          <figure key={image.id}>
            <img
              src={`data:${image.mime};base64,${image.data}`}
              alt={`Screenshot ${index + 1} preview`}
            />
            <figcaption>
              Screenshot {index + 1}{" "}
              <button
                type="button"
                disabled={disabled || draft.busy}
                aria-label={`Remove screenshot ${index + 1}`}
                onClick={() => draft.remove(image.id)}
              >
                Remove
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
