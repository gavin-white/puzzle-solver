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
