export const panelIds = [
  "project",
  "palette",
  "graph",
  "code",
  "analysis",
  "console",
  "tests",
  "changes",
] as const;
export type PanelId = (typeof panelIds)[number];
export const panelLabels: Record<PanelId, string> = {
  project: "Проект",
  palette: "Блоки",
  graph: "Схема",
  code: "Код Java",
  analysis: "Анализ",
  console: "Консоль",
  tests: "Тесты",
  changes: "Изменения",
};
export type Group = {
  type: "group";
  id: string;
  tabs: PanelId[];
  active: PanelId;
};
export type Split = {
  type: "split";
  id: string;
  axis: "horizontal" | "vertical";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
};
export type LayoutNode = Group | Split;
export type WorkspaceLayout = {
  version: 1;
  root: LayoutNode;
  hidden?: PanelId[];
};
export type DropEdge = "center" | "left" | "right" | "top" | "bottom" | "tabs";
const group = (id: string, tabs: PanelId[], active = tabs[0]): Group => ({
  type: "group",
  id,
  tabs,
  active,
});
const split = (
  id: string,
  axis: Split["axis"],
  ratio: number,
  first: LayoutNode,
  second: LayoutNode,
): Split => ({ type: "split", id, axis, ratio, first, second });
export function defaultLayout(
  preset: "default" | "code" | "review" = "default",
): WorkspaceLayout {
  if (preset === "code")
    return {
      version: 1,
      root: split(
        "root",
        "horizontal",
        0.2,
        group("project", ["project", "palette"]),
        split(
          "work",
          "vertical",
          0.7,
          group("code", ["code", "graph"]),
          group("bottom", ["console", "tests", "changes", "analysis"]),
        ),
      ),
    };
  if (preset === "review")
    return {
      version: 1,
      root: split(
        "root",
        "horizontal",
        0.65,
        split(
          "work",
          "vertical",
          0.65,
          group("graph", ["graph", "code"]),
          group("bottom", ["changes", "tests", "console"]),
        ),
        group("analysis", ["analysis", "project", "palette"]),
      ),
    };
  return {
    version: 1,
    hidden: ["palette", "tests", "changes"],
    root: split(
      "root",
      "horizontal",
      0.18,
      split(
        "left",
        "vertical",
        0.7,
        group("project", ["project"]),
        group("palette", ["palette"]),
      ),
      split(
        "main",
        "vertical",
        0.7,
        split(
          "top",
          "horizontal",
          0.8,
          group("graph", ["graph"]),
          group("analysis", ["analysis"]),
        ),
        split(
          "bottom",
          "horizontal",
          0.53,
          group("code", ["code"]),
          group("output", ["console", "tests", "changes"]),
        ),
      ),
    ),
  };
}
export function groups(node: LayoutNode): Group[] {
  return node.type === "group"
    ? [node]
    : [...groups(node.first), ...groups(node.second)];
}
export function visiblePanels(layout: WorkspaceLayout): PanelId[] {
  return groups(layout.root)
    .flatMap((g) => g.tabs)
    .filter((p) => !layout.hidden?.includes(p));
}
// Pruning is a projection only: hidden tabs retain their exact split and ratio.
export function visibleRoot(layout: WorkspaceLayout): LayoutNode {
  function prune(node: LayoutNode): LayoutNode | null {
    if (node.type === "group") {
      const tabs = node.tabs.filter((p) => !layout.hidden?.includes(p));
      return tabs.length
        ? {
            ...node,
            tabs,
            active: tabs.includes(node.active) ? node.active : tabs[0],
          }
        : null;
    }
    const first = prune(node.first),
      second = prune(node.second);
    return first && second ? { ...node, first, second } : (first ?? second);
  }
  return prune(layout.root) ?? group("graph", ["graph"]);
}
export function activePanels(layout: WorkspaceLayout): PanelId[] {
  return groups(visibleRoot(layout)).map((g) => g.active);
}
export function validateLayout(value: unknown): value is WorkspaceLayout {
  if (
    !value ||
    typeof value !== "object" ||
    (value as WorkspaceLayout).version !== 1
  )
    return false;
  const panels = new Set<string>(),
    ids = new Set<string>();
  let count = 0;
  function valid(node: unknown, depth: number): boolean {
    if (!node || typeof node !== "object" || depth > 12 || ++count > 31)
      return false;
    const n = node as LayoutNode;
    if (
      typeof n.id !== "string" ||
      !/^[\w-]{1,80}$/.test(n.id) ||
      ids.has(n.id)
    )
      return false;
    ids.add(n.id);
    if (n.type === "group")
      return (
        Array.isArray(n.tabs) &&
        n.tabs.length > 0 &&
        n.tabs.length <= panelIds.length &&
        n.tabs.includes(n.active) &&
        n.tabs.every((p) => {
          if (!panelIds.includes(p) || panels.has(p)) return false;
          panels.add(p);
          return true;
        })
      );
    return (
      n.type === "split" &&
      ["horizontal", "vertical"].includes(n.axis) &&
      Number.isFinite(n.ratio) &&
      n.ratio >= 0.15 &&
      n.ratio <= 0.85 &&
      valid(n.first, depth + 1) &&
      valid(n.second, depth + 1)
    );
  }
  const l = value as WorkspaceLayout;
  return (
    valid(l.root, 0) &&
    (l.hidden === undefined ||
      (Array.isArray(l.hidden) &&
        new Set(l.hidden).size === l.hidden.length &&
        !l.hidden.includes("graph") &&
        l.hidden.every((p) => panelIds.includes(p) && panels.has(p))))
  );
}
export function readLayout(projectId: string): WorkspaceLayout {
  try {
    const raw = localStorage.getItem(layoutKey(projectId));
    if (raw !== null) {
      const value: unknown = JSON.parse(raw);
      return validateLayout(value) ? value : defaultLayout();
    }
  } catch {
    return defaultLayout();
  }
  let layout = defaultLayout();
  try {
    const previous = JSON.parse(
      localStorage.getItem("java-blueprints:workspace:v1:" + projectId) ??
        "null",
    );
    if (validateLayout(previous)) {
      const oldDefault = split(
        "root",
        "horizontal",
        0.18,
        split(
          "left",
          "vertical",
          0.7,
          group("project", ["project"]),
          group("palette", ["palette"]),
        ),
        split(
          "main",
          "vertical",
          0.65,
          split(
            "top",
            "horizontal",
            0.74,
            group("graph", ["graph"]),
            group("analysis", ["analysis"]),
          ),
          split(
            "bottom",
            "horizontal",
            0.64,
            group("code", ["code"]),
            group("output", ["console", "tests", "changes"]),
          ),
        ),
      );
      return JSON.stringify(previous.root) === JSON.stringify(oldDefault)
        ? defaultLayout()
        : previous;
    }
    const legacy = JSON.parse(
      localStorage.getItem("java-blueprints:view:" + projectId) ?? "null",
    );
    if (legacy?.mode === "code") layout = defaultLayout("code");
    if (legacy?.mode === "graph") layout = hidePanel(layout, "code");
    if (legacy?.inspector === false) layout = hidePanel(layout, "analysis");
  } catch {}
  return layout;
}
export const layoutKey = (projectId: string) =>
  "java-blueprints:workspace:v2:" + projectId;
function mapNode(
  node: LayoutNode,
  fn: (node: LayoutNode) => LayoutNode,
): LayoutNode {
  return fn(
    node.type === "group"
      ? node
      : {
          ...node,
          first: mapNode(node.first, fn),
          second: mapNode(node.second, fn),
        },
  );
}
function remove(node: LayoutNode, panel: PanelId): LayoutNode | null {
  if (node.type === "group") {
    const tabs = node.tabs.filter((p) => p !== panel);
    return tabs.length
      ? {
          ...node,
          tabs,
          active: tabs.includes(node.active) ? node.active : tabs[0],
        }
      : null;
  }
  const first = remove(node.first, panel),
    second = remove(node.second, panel);
  return first && second ? { ...node, first, second } : (first ?? second);
}
export function hidePanel(
  layout: WorkspaceLayout,
  panel: PanelId,
): WorkspaceLayout {
  if (panel === "graph" || !visiblePanels(layout).includes(panel))
    return layout;
  return { ...layout, hidden: [...(layout.hidden ?? []), panel] };
}
export function revealPanel(
  layout: WorkspaceLayout,
  panel: PanelId,
): WorkspaceLayout {
  const target = groups(layout.root).find((g) => g.tabs.includes(panel));
  const id = target?.id ?? groups(layout.root)[0].id;
  return {
    ...layout,
    hidden: layout.hidden?.filter((p) => p !== panel),
    root: mapNode(layout.root, (n) =>
      n.type === "group" && n.id === id
        ? {
            ...n,
            tabs: n.tabs.includes(panel) ? n.tabs : [...n.tabs, panel],
            active: panel,
          }
        : n,
    ),
  };
}
export function resizeSplit(
  layout: WorkspaceLayout,
  id: string,
  ratio: number,
): WorkspaceLayout {
  if (!Number.isFinite(ratio)) return layout;
  return {
    ...layout,
    root: mapNode(layout.root, (n) =>
      n.type === "split" && n.id === id
        ? { ...n, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
        : n,
    ),
  };
}
export function movePanel(
  layout: WorkspaceLayout,
  panel: PanelId,
  targetId: string,
  edge: DropEdge,
): WorkspaceLayout {
  const target = groups(visibleRoot(layout)).find((g) => g.id === targetId);
  const source = groups(layout.root).find((g) => g.tabs.includes(panel));
  if (target?.active === "graph" && edge === "center") edge = "right";
  if (
    panel === "graph" ||
    !target ||
    !source ||
    (source.id === target.id && (edge === "center" || source.tabs.length === 1))
  )
    return layout;
  if (edge === "tabs") {
    if (source.id === target.id) return revealPanel(layout, panel);
    const root = remove(layout.root, panel);
    return root
      ? {
          ...layout,
          root: mapNode(root, (n) =>
            n.type === "group" && n.id === targetId
              ? { ...n, tabs: [...n.tabs, panel], active: panel }
              : n,
          ),
        }
      : layout;
  }
  if (edge === "center") {
    const other = target.active;
    return {
      ...layout,
      root: mapNode(layout.root, (n) =>
        n.type !== "group"
          ? n
          : {
              ...n,
              tabs: n.tabs.map((p) =>
                p === panel ? other : p === other ? panel : p,
              ),
              active:
                n.active === panel
                  ? other
                  : n.active === other
                    ? panel
                    : n.active,
            },
      ),
    };
  }
  const root = remove(layout.root, panel);
  if (!root) return layout;
  const used = new Set<string>();
  const visit = (n: LayoutNode) => {
    used.add(n.id);
    if (n.type === "split") {
      visit(n.first);
      visit(n.second);
    }
  };
  visit(root);
  const fresh = (prefix: string) => {
    let i = 1;
    while (used.has(prefix + i)) i++;
    used.add(prefix + i);
    return prefix + i;
  };
  const result: WorkspaceLayout = {
    ...layout,
    root: mapNode(root, (n) => {
      if (n.id !== targetId) return n;
      const added = group(fresh("group-"), [panel]);
      const before = edge === "left" || edge === "top";
      return split(
        fresh("split-"),
        edge === "left" || edge === "right" ? "horizontal" : "vertical",
        0.5,
        before ? added : n,
        before ? n : added,
      );
    }),
  };
  return validateLayout(result) ? result : layout;
}
