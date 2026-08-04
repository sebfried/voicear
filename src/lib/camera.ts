const FRAME_TIMEOUT_MS = 1_500;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export const clampCameraOpacity = (percent: number) =>
  clamp(Number.isFinite(percent) ? percent : 100, 0, 100);

export const fitFrameSize = (width: number, height: number, maxEdge: number) => {
  if (![width, height, maxEdge].every(Number.isFinite) || width <= 0 || height <= 0 || maxEdge <= 0) {
    throw new RangeError("Frame dimensions and maxEdge must be positive finite numbers.");
  }

  const limit = Math.max(1, Math.floor(maxEdge));
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
};

const hasCurrentFrame = (video: HTMLVideoElement) =>
  video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0;

const waitForCurrentFrame = (video: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
  let settled = false;
  let scheduled = false;
  const hasVideoFrameCallback = typeof video.requestVideoFrameCallback === "function";
  let videoFrameId: number | undefined;
  let fallbackId: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    video.removeEventListener("loadeddata", schedule);
    video.removeEventListener("canplay", schedule);
    clearTimeout(timeoutId);
    if (fallbackId !== undefined) clearTimeout(fallbackId);
    if (videoFrameId !== undefined) video.cancelVideoFrameCallback?.(videoFrameId);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error("Camera did not provide a usable video frame."));
  };
  function schedule() {
    if (scheduled || !hasCurrentFrame(video)) return;
    scheduled = true;
    if (hasVideoFrameCallback) {
      videoFrameId = video.requestVideoFrameCallback(finish);
    } else {
      fallbackId = setTimeout(finish, 32);
    }
  }

  const timeoutId = setTimeout(() => !hasVideoFrameCallback && hasCurrentFrame(video) ? finish() : fail(), FRAME_TIMEOUT_MS);
  video.addEventListener("loadeddata", schedule);
  video.addEventListener("canplay", schedule);
  schedule();
});

const encodeJpeg = async (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  { maxEdge, quality }: { maxEdge: number; quality: number }
) => {
  const { width, height } = fitFrameSize(sourceWidth, sourceHeight, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(source, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error("Image encoding failed.")),
      "image/jpeg",
      clamp(Number.isFinite(quality) ? quality : 0.8, 0, 1)
    );
  });

  return { blob, width, height, mimeType: blob.type || "image/jpeg" };
};

export const captureCameraFrame = async (
  video: HTMLVideoElement,
  { maxEdge, quality }: { maxEdge: number; quality: number }
) => {
  try {
    await video.play();
  } catch (error) {
    if (!hasCurrentFrame(video)) throw new Error("Camera preview could not be started.", { cause: error });
  }

  await waitForCurrentFrame(video);
  if (!hasCurrentFrame(video)) throw new Error("Camera did not provide a usable video frame.");
  return encodeJpeg(video, video.videoWidth, video.videoHeight, { maxEdge, quality });
};

export const resizeImageBlob = async (
  blob: Blob,
  { maxEdge, quality }: { maxEdge: number; quality: number }
) => {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("Stored photo could not be decoded.")), { once: true });
      image.src = url;
    });
    return encodeJpeg(image, image.naturalWidth, image.naturalHeight, { maxEdge, quality });
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const blobToDataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
};
