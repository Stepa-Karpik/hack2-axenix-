type Point = { x: number; y: number };
type Segment = { axis: number; start: number; end: number };

/** Exact parallel-overlap score with bounded spatial buckets, rather than rescanning every prior route. */
export class RouteCrowdingIndex {
  private vertical = new Map<string, Segment[]>();
  private horizontal = new Map<string, Segment[]>();
  private longVertical: Segment[] = [];
  private longHorizontal: Segment[] = [];
  private allVertical: Segment[] = [];
  private allHorizontal: Segment[] = [];

  private segments(
    points: Point[],
    visit: (vertical: boolean, segment: Segment) => void,
  ) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if (a.x === b.x)
        visit(true, {
          axis: a.x,
          start: Math.min(a.y, b.y),
          end: Math.max(a.y, b.y),
        });
      if (a.y === b.y)
        visit(false, {
          axis: a.y,
          start: Math.min(a.x, b.x),
          end: Math.max(a.x, b.x),
        });
    }
  }

  add(points: Point[]) {
    this.segments(points, (vertical, segment) => {
      const cells = vertical ? this.vertical : this.horizontal;
      (vertical ? this.allVertical : this.allHorizontal).push(segment);
      const start = Math.floor(segment.start / 256),
        end = Math.floor(segment.end / 256);
      // A manually moved node can produce a very long route: keep storage bounded.
      if (end - start > 256) {
        (vertical ? this.longVertical : this.longHorizontal).push(segment);
        return;
      }
      const axis = Math.floor(segment.axis / 10);
      for (let cell = start; cell <= end; cell++) {
        const key = `${axis}:${cell}`,
          bucket = cells.get(key);
        if (bucket) bucket.push(segment);
        else cells.set(key, [segment]);
      }
    });
  }

  score(points: Point[]) {
    let score = 0;
    this.segments(points, (vertical, segment) => {
      const start = Math.floor(segment.start / 256),
        end = Math.floor(segment.end / 256);
      const candidates = new Set<Segment>(
        vertical ? this.longVertical : this.longHorizontal,
      );
      if (end - start > 256) {
        for (const prior of vertical ? this.allVertical : this.allHorizontal)
          candidates.add(prior);
      } else {
        const cells = vertical ? this.vertical : this.horizontal,
          axis = Math.floor(segment.axis / 10);
        for (let direction = -1; direction <= 1; direction++)
          for (let cell = start; cell <= end; cell++)
            for (const prior of cells.get(`${axis + direction}:${cell}`) ?? [])
              candidates.add(prior);
      }
      for (const prior of candidates)
        if (Math.abs(segment.axis - prior.axis) < 10)
          score += Math.max(
            0,
            Math.min(segment.end, prior.end) -
              Math.max(segment.start, prior.start),
          );
    });
    return score;
  }
}
