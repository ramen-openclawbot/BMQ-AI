// Roboto font subset supporting Vietnamese characters
// This is a base64-encoded TTF file

// Using a CDN approach - we'll fetch the font dynamically
export const ROBOTO_FONT_URL = "https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf";
export const ROBOTO_BOLD_FONT_URL = "https://fonts.gstatic.com/s/roboto/v30/KFOlCnqEu92Fr1MmWUlvAx05IsDqlA.ttf";

async function fetchFontAsBase64(url: string): Promise<string> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

export async function loadRobotoFont(): Promise<string> {
  try {
    return await fetchFontAsBase64(ROBOTO_FONT_URL);
  } catch (error) {
    console.error("Failed to load Roboto font:", error);
    throw error;
  }
}

export async function loadRobotoBoldFont(): Promise<string> {
  try {
    return await fetchFontAsBase64(ROBOTO_BOLD_FONT_URL);
  } catch (error) {
    console.error("Failed to load Roboto Bold font:", error);
    throw error;
  }
}

// Helper to load image with dimensions for proper aspect ratio
export async function loadImageWithDimensions(url: string): Promise<{
  base64: string;
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        resolve({
          base64: canvas.toDataURL("image/png"),
          width: img.width,
          height: img.height
        });
      } else {
        reject(new Error("Could not get canvas context"));
      }
    };
    img.onerror = reject;
    img.src = url;
  });
}
