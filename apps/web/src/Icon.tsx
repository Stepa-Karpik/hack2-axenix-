import {
  Upload,
  Download,
  Play,
  GitCompareArrows,
  PanelRight,
  Search,
  CodeXml,
  ChevronDown,
  RefreshCw,
  X,
  ArrowUpRight,
  ArrowRight,
  Workflow,
  Terminal,
  GitPullRequest,
  Braces,
  FileCode2,
  CornerUpLeft,
  Sun,
  Moon,
} from "lucide-react";
const icons = {
  upload: Upload,
  download: Download,
  play: Play,
  compare: GitCompareArrows,
  panel: PanelRight,
  search: Search,
  code: CodeXml,
  chevron: ChevronDown,
  refresh: RefreshCw,
  close: X,
  external: ArrowUpRight,
  arrow: ArrowRight,
  workflow: Workflow,
  terminal: Terminal,
  changes: GitPullRequest,
  method: Braces,
  file: FileCode2,
  back: CornerUpLeft,
  sun: Sun,
  moon: Moon,
};
export default function Icon({
  name,
  size = 16,
}: {
  name: keyof typeof icons;
  size?: number;
}) {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={1.65} aria-hidden="true" />;
}
