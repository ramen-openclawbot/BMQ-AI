import { useState, type CSSProperties } from "react";
import type { ImageRotation } from "@/lib/image-rotation";

interface RotatedImageProps {
  src: string;
  alt: string;
  rotation: ImageRotation;
  /** CSS length the shown (rotated) image may not exceed in height, e.g. "12rem" or "70vh". */
  maxHeight?: string;
  /** Width of the shown image box; the game viewer passes the zoom ("200%"). */
  width?: string;
  className?: string;
  onClick?: () => void;
  loading?: "lazy" | "eager";
}

/**
 * Shows a stored photo turned clockwise by `rotation` without touching the file. For 90/270 the box takes
 * the turned aspect ratio, so the layout around it stays correct (a plain CSS rotate would overflow).
 */
export function RotatedImage({ src, alt, rotation, maxHeight, width, className, onClick, loading }: RotatedImageProps) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const sideways = rotation === 90 || rotation === 270;

  if (!sideways) {
    return (
      <img
        src={src}
        alt={alt}
        loading={loading}
        className={className}
        onClick={onClick}
        style={{ maxHeight, width, transform: rotation ? `rotate(${rotation}deg)` : undefined }}
      />
    );
  }

  // Box ratio after the turn is h:w. Its width is capped so its height never passes maxHeight.
  const ratio = size ? size.h / size.w : 1.4;
  const box: CSSProperties = {
    position: "relative",
    width: maxHeight ? `min(${width ?? "100%"}, calc(${maxHeight} * ${ratio}))` : width ?? "100%",
    aspectRatio: `${ratio}`,
    overflow: "hidden",
    flexShrink: 0,
  };
  return (
    <div className={className} style={box} onClick={onClick} data-bmq-rotated-image={rotation}>
      <img
        src={src}
        alt={alt}
        loading={loading}
        onLoad={(event) => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          // Before the turn the photo is as wide as the box is tall: box height / box width = 1 / ratio.
          width: `${100 / ratio}%`,
          maxWidth: "none",
          maxHeight: "none",
          height: "auto",
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          visibility: size ? "visible" : "hidden",
        }}
      />
    </div>
  );
}
