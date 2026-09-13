/**
 * Replaceable icon map. Every icon in the workstation shell goes through
 * this registry, keyed by the `iconKey` strings used in the tool registry
 * and shell chrome. Currently backed by lucide-react; swapping the icon set
 * means editing this one file.
 */

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Download,
  FileImage,
  FilePlus2,
  FolderOpen,
  Grid2x2,
  HelpCircle,
  History,
  Home,
  ImagePlus,
  Layers3,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  MonitorUp,
  MoreVertical,
  MousePointer2,
  Move,
  PackageCheck,
  PanelRight,
  Printer,
  Redo2,
  RotateCcw,
  Save,
  Scaling,
  Sparkles,
  Upload,
  Waves,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP = {
  /* Tool registry iconKeys (core/tool-registry.ts) */
  select: MousePointer2,
  layers: Layers3,
  halftone: Grid2x2,
  diffusion: Waves,
  glitch: Zap,
  plates: Printer,
  history: History,
  export: PackageCheck,

  /* Shell chrome */
  home: Home,
  "file-new": FilePlus2,
  "file-open": FolderOpen,
  "file-save": Save,
  undo: RotateCcw,
  redo: Redo2,
  download: Download,
  help: HelpCircle,
  "chevron-down": ChevronDown,
  check: Check,
  close: X,
  warning: AlertTriangle,
  copy: Copy,
  "clipboard-check": ClipboardCheck,
  "image-add": ImagePlus,
  "file-image": FileImage,
  reset: RotateCcw,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  upload: Upload,
  sparkles: Sparkles,
  monitor: MonitorUp,
  lock: Lock,
  unlock: LockOpen,
  "focus-enter": Maximize2,
  "focus-exit": Minimize2,
  "panel-menu": MoreVertical,
  "dock-right": PanelRight,
  move: Move,
  resize: Scaling,
} satisfies Record<string, LucideIcon>;

export type IconKey = keyof typeof ICON_MAP;

export function getIconComponent(name: string): LucideIcon {
  return (ICON_MAP as Record<string, LucideIcon>)[name] ?? HelpCircle;
}

type IconProps = {
  name: IconKey | (string & {});
  size?: number;
  /** Icons are decorative by default; pair them with text or aria-labels. */
  className?: string;
};

export function Icon({ name, size = 16, className }: IconProps) {
  const Component = getIconComponent(name);
  return <Component size={size} className={className} aria-hidden="true" />;
}
