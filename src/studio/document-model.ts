export const DOCUMENT_DPI = 240;

export const SHEET_SIZES = [
  {
    id: "letter",
    label: "Letter (8.5×11)",
    widthInches: 8.5,
    heightInches: 11,
  },
  { id: "a4", label: "A4", widthInches: 8.27, heightInches: 11.69 },
  { id: "8x10", label: "8×10 in", widthInches: 8, heightInches: 10 },
  { id: "9x12", label: "9×12 in", widthInches: 9, heightInches: 12 },
  { id: "11x15", label: "11×15 in", widthInches: 11, heightInches: 15 },
  { id: "11x17", label: "11×17 in", widthInches: 11, heightInches: 17 },
  { id: "13x19", label: "13×19 in", widthInches: 13, heightInches: 19 },
  { id: "15x22", label: "15×22 in", widthInches: 15, heightInches: 22 },
] as const;

export type SheetSizeId = (typeof SHEET_SIZES)[number]["id"];
export type Orientation = "portrait" | "landscape";
export type MirrorDirection = "horizontal" | "vertical";

export type DocumentSettings = {
  sheetSize: SheetSizeId;
  orientation: Orientation;
  scalePercent: number;
  offsetX: number;
  offsetY: number;
  mirrorImage: boolean;
  mirrorDirection: MirrorDirection;
};

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  sheetSize: "11x15",
  orientation: "portrait",
  scalePercent: 100,
  offsetX: 0,
  offsetY: 0,
  mirrorImage: false,
  mirrorDirection: "horizontal",
};

export function getSheetPixelDimensions(
  sheetSize: SheetSizeId,
  orientation: Orientation,
) {
  const sheet = SHEET_SIZES.find(({ id }) => id === sheetSize);
  if (!sheet) throw new Error(`Unknown sheet size: ${sheetSize}`);

  const portraitWidth = Math.round(sheet.widthInches * DOCUMENT_DPI);
  const portraitHeight = Math.round(sheet.heightInches * DOCUMENT_DPI);

  return orientation === "portrait"
    ? { width: portraitWidth, height: portraitHeight }
    : { width: portraitHeight, height: portraitWidth };
}

type ArtworkPlacementInput = {
  sourceWidth: number;
  sourceHeight: number;
  sheetWidth: number;
  sheetHeight: number;
  scalePercent: number;
  offsetX: number;
  offsetY: number;
};

export function calculateArtworkPlacement({
  sourceWidth,
  sourceHeight,
  sheetWidth,
  sheetHeight,
  scalePercent,
  offsetX,
  offsetY,
}: ArtworkPlacementInput) {
  const scale = scalePercent / 100;
  const width = Math.max(1, Math.trunc(sourceWidth * scale));
  const height = Math.max(1, Math.trunc(sourceHeight * scale));

  return {
    x: Math.floor((sheetWidth - width) / 2) + offsetX,
    y: Math.floor((sheetHeight - height) / 2) + offsetY,
    width,
    height,
  };
}

export function getFitScalePercent(
  sourceWidth: number,
  sourceHeight: number,
  sheetWidth: number,
  sheetHeight: number,
) {
  const fitPercent = Math.round(
    Math.min(sheetWidth / sourceWidth, sheetHeight / sourceHeight) * 100,
  );

  return Math.min(400, Math.max(10, fitPercent));
}
