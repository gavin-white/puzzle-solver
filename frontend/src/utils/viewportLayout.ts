type FitImageOptions = {
  padding?: number;
  widthRatio?: number;
  heightRatio?: number;
  maxScale?: number;
};

export function fitImageToViewport(
  naturalWidth: number,
  naturalHeight: number,
  {
    padding = 80,
    widthRatio = 0.9,
    heightRatio = 0.9,
    maxScale = Number.POSITIVE_INFINITY,
  }: FitImageOptions = {}
) {
  const viewportWidth = window.innerWidth - padding;
  const viewportHeight = window.innerHeight - padding;
  const scaleX = (viewportWidth * widthRatio) / naturalWidth;
  const scaleY = (viewportHeight * heightRatio) / naturalHeight;
  const scale = Math.min(scaleX, scaleY, maxScale);

  return {
    displayWidth: naturalWidth * scale,
    displayHeight: naturalHeight * scale,
    scale,
  };
}

/** Fit image to a measured container instead of the full window. */
export function fitImageToContainer(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
  {
    padding = 16,
    widthRatio = 0.95,
    heightRatio = 0.95,
    maxScale = Number.POSITIVE_INFINITY,
  }: FitImageOptions = {}
) {
  const availableWidth = Math.max(0, containerWidth - padding);
  const availableHeight = Math.max(0, containerHeight - padding);
  const scaleX = (availableWidth * widthRatio) / naturalWidth;
  const scaleY = (availableHeight * heightRatio) / naturalHeight;
  const scale = Math.min(scaleX, scaleY, maxScale);

  return {
    displayWidth: naturalWidth * scale,
    displayHeight: naturalHeight * scale,
    scale,
  };
}

/** Width-responsive fit options for solve-flow image editors. */
export function fitOptionsForContainerWidth(containerWidth: number, maxScale?: number): FitImageOptions {
  if (containerWidth <= 768) {
    return {
      padding: 12,
      widthRatio: 0.98,
      heightRatio: 0.98,
      maxScale: maxScale ?? Number.POSITIVE_INFINITY,
    };
  }
  return {
    padding: 24,
    widthRatio: 0.92,
    heightRatio: 0.9,
    maxScale: maxScale ?? Number.POSITIVE_INFINITY,
  };
}
