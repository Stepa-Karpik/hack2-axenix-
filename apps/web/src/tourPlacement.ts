export type TourRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export function placeTourCard(
  target: TourRect | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const margin = 16,
    gap = 18;
  const width = Math.min(size.width, viewport.width - margin * 2),
    height = Math.min(size.height, viewport.height - margin * 2);
  const clamp = (left: number, top: number) => ({
    left: Math.max(margin, Math.min(viewport.width - width - margin, left)),
    top: Math.max(margin, Math.min(viewport.height - height - margin, top)),
  });
  if (!target)
    return clamp((viewport.width - width) / 2, (viewport.height - height) / 2);
  const candidates = [
    clamp(target.left + target.width + gap, target.top),
    clamp(target.left - width - gap, target.top),
    clamp(target.left, target.top + target.height + gap),
    clamp(target.left, target.top - height - gap),
  ];
  const overlap = (p: { left: number; top: number }) =>
    Math.max(
      0,
      Math.min(p.left + width, target.left + target.width + 6) -
        Math.max(p.left, target.left - 6),
    ) *
    Math.max(
      0,
      Math.min(p.top + height, target.top + target.height + 6) -
        Math.max(p.top, target.top - 6),
    );
  const best = candidates
    .map((p, index) => ({ ...p, score: overlap(p), index }))
    .sort((a, b) => a.score - b.score || a.index - b.index)[0];
  return { left: best.left, top: best.top };
}
