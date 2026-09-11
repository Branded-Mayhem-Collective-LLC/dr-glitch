# halftone_glitch.py
# UI: Top toolbar (open / exports / icc).
# Left column: overview, artboard, TOOLBOX (cmyk+halftone, glitch fx, registration).
# Right column: zoom controls + preview. Rendering logic matches previous builds.

import os, sys, math, json, copy, time, tempfile, shutil
from collections import deque
from dataclasses import dataclass, replace, field, asdict, fields
from typing import Optional, Tuple, List, Dict, cast
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import cpu_count

import numpy as np
# For dithering features
try:
    from scipy.ndimage import gaussian_filter, rotate as nd_rotate
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    gaussian_filter = None  # type: ignore
    nd_rotate = None  # type: ignore

# Performance optimization imports
try:
    import numba
    HAS_NUMBA = True
    # Enable optimal threading for CPU operations
    numba.set_num_threads(max(2, min(8, cpu_count() or 4)))
except ImportError:
    HAS_NUMBA = False
    numba = None  # type: ignore

# ── Numba-accelerated error-diffusion inner loop ──────────────────────
if HAS_NUMBA:
    assert numba is not None
    @numba.njit(cache=True)
    def _diffuse_loop_njit(result, kernel_dy, kernel_dx, kernel_w, divisor, intensity, levels):
        h, w = result.shape
        step = np.float32(1.0 / (levels - 1))
        inv_step = np.float32(1.0 / step)
        nk = kernel_dy.shape[0]
        for y in range(h):
            for x in range(w):
                old_val = result[y, x]
                clamped = min(max(old_val, np.float32(0.0)), np.float32(1.0))
                new_val = round(clamped * inv_step) * step
                result[y, x] = new_val
                error = (old_val - new_val) * intensity
                if error == np.float32(0.0):
                    continue
                for ki in range(nk):
                    ny = y + kernel_dy[ki]
                    nx = x + kernel_dx[ki]
                    if 0 <= ny < h and 0 <= nx < w:
                        result[ny, nx] += error * kernel_w[ki] / divisor
        return result

    @numba.njit(cache=True)
    def _diffuse_loop_glitch_njit(result, kernel_dy, kernel_dx, kernel_w, divisor,
                                   intensity, levels, error_overflow, reset_rows):
        """Error diffusion with overflow wrap-around and periodic buffer resets."""
        h, w = result.shape
        step = np.float32(1.0 / (levels - 1))
        inv_step = np.float32(1.0 / step)
        nk = kernel_dy.shape[0]
        next_reset = 0  # index into reset_rows
        n_resets = reset_rows.shape[0]
        for y in range(h):
            # Diffusion reset: zero the row when we hit a reset boundary
            if next_reset < n_resets and y == reset_rows[next_reset]:
                for rx in range(w):
                    old_r = result[y, rx]
                    clamped_r = min(max(old_r, np.float32(0.0)), np.float32(1.0))
                    result[y, rx] = clamped_r  # wipe accumulated error
                next_reset += 1
            for x in range(w):
                old_val = result[y, x]
                if error_overflow > np.float32(0.0):
                    # Mix between clamped and modular (wrap) behaviour
                    clamped = min(max(old_val, np.float32(0.0)), np.float32(1.0))
                    wrapped = old_val - np.float32(int(old_val))  # frac part
                    if wrapped < np.float32(0.0):
                        wrapped += np.float32(1.0)
                    val = clamped * (np.float32(1.0) - error_overflow) + wrapped * error_overflow
                else:
                    val = min(max(old_val, np.float32(0.0)), np.float32(1.0))
                new_val = round(val * inv_step) * step
                result[y, x] = new_val
                error = (old_val - new_val) * intensity
                if error == np.float32(0.0):
                    continue
                for ki in range(nk):
                    ny = y + kernel_dy[ki]
                    nx = x + kernel_dx[ki]
                    if 0 <= ny < h and 0 <= nx < w:
                        result[ny, nx] += error * kernel_w[ki] / divisor
        return result
else:
    _diffuse_loop_njit = None  # type: ignore
    _diffuse_loop_glitch_njit = None  # type: ignore

# GPU acceleration support
try:
    import cupy as cp  # type: ignore
    HAS_CUPY = cp.cuda.is_available()
    if HAS_CUPY:
        # Configure GPU memory pool for optimal performance
        mempool = cp.get_default_memory_pool()
        mempool.set_limit(size=2**30)  # 1GB limit to prevent GPU memory issues
except ImportError:
    HAS_CUPY = False
    cp = None  # type: ignore

# Fast image processing backend
try:
    import cv2
    HAS_OPENCV = True
except (ImportError, ModuleNotFoundError):
    HAS_OPENCV = False
    cv2 = None  # type: ignore

from PIL import Image, ImageDraw, ImageChops

# Optional CMS
ImageCms = None
try:
    from PIL import ImageCms
    HAS_CMS = True
except Exception:
    HAS_CMS = False

import svgwrite

# Optional vector helpers
try:
    from svgpathtools import svg2paths2, Path as SVGPath
    HAS_SVGPATHTOOLS = True
except Exception:
    HAS_SVGPATHTOOLS = False
    SVGPath = None  # type: ignore
    svg2paths2 = None  # type: ignore

# Optional: crisp PDF export
try:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.units import inch as RL_INCH
    from reportlab.lib.utils import ImageReader
    HAS_REPORTLAB = True
except Exception:
    HAS_REPORTLAB = False
    rl_canvas = None  # type: ignore
    RL_INCH = None  # type: ignore
    ImageReader = None  # type: ignore

# Optional: Font to path conversion for SVG export
try:
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    HAS_FONTTOOLS = True
except Exception:
    HAS_FONTTOOLS = False
    TTFont = None  # type: ignore
    SVGPathPen = None  # type: ignore

from PySide6.QtCore import Qt, QSize, QTimer, QPoint, QRect, Signal, QThread, QObject
from PySide6.QtGui import QPixmap, QImage, QMouseEvent, QPainter, QPen, QColor, QPainterPath, QIcon, QBrush, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QLabel, QFileDialog, QPushButton,
    QVBoxLayout, QHBoxLayout, QComboBox, QCheckBox, QSlider, QDial,
    QMessageBox, QGroupBox, QGridLayout, QSizePolicy, QToolBox, QSplitter,
    QLineEdit, QProgressDialog, QMenu
)

ICON_PATH = r"C:\Halftone_CMYK\halftone_cmyk.ico"
MAX_LONG_SIDE = 7680
DOC_DPI = 240
GRID_BUDGET_PREVIEW = 800_000
GRID_BUDGET_INTERACT = 400_000
INTERACT_SCALE = 0.35
INTERACT_SCALE_LARGE = 0.25
LARGE_IMAGE_PIXELS = 4_000_000
Image.MAX_IMAGE_PIXELS = None   # Allow large artboards at high zoom without DecompressionBombError
SIZE_QUANT_INTERACT = 2

QSS = """
QWidget { background:#414042; color:#fff; font-size:10pt; }
QGroupBox { border:1px solid #444; margin-top:12px; padding:10px 8px 8px 8px; }
QGroupBox::title { left:8px; color:#fff; text-transform: lowercase; }

QPushButton {
  background:#363436; color:#fff; border:1px solid #444;
  padding:6px 10px; letter-spacing:0.5px; text-transform: lowercase;
  border-radius:6px;
}
QPushButton:hover { background:#4a484a; }
QPushButton#ResetButton { 
  background:#613232; 
  padding:4px 8px;  /* More compact for accordion sections */
  font-size:11px;   /* Slightly smaller font */
  min-height:20px;  /* Ensure minimum height */
}
QPushButton#ResetButton:hover { background:#7a4040; }

QComboBox {
  background:#363436; border:1px solid #444; padding:2px 6px; color:#fff;
  text-transform: lowercase; border-radius:6px;
}
QComboBox QAbstractItemView {
  background:#363436; color:#fff; selection-background-color:#4a484a;
  border:1px solid #444; border-radius:6px;
}
QLabel { text-transform: lowercase; }

QSlider::groove:horizontal { height:2px; margin:0px; background:#fff; border:none; }
QSlider::handle:horizontal { width:14px; height:14px; margin:-7px 0; border:2px solid #fff; background:#000; border-radius:7px; }

QDial#dialC { background:#00bcd4; border:2px solid #000; border-radius:24px; }
QDial#dialM { background:#ff4081; border:2px solid #000; border-radius:24px; }
QDial#dialY { background:#ffea00; border:2px solid #000; border-radius:24px; }
QDial#dialK { background:#111;     border:2px solid #fff; border-radius:24px; }

#MoireBox { background:#fff; border:1px solid #666; border-radius:6px; }

#PreviewArea {
  background: qlineargradient(
    x1:0, y1:0, x2:0, y2:1,
    stop:0 #7a7b7e,
    stop:1 #6d6e71
  );
  border:6px solid #555;
  border-radius:14px;

  /* sunken bevel effect */
  border-top: 6px solid #2e2f31;
  border-left: 6px solid #2e2f31;
  border-right: 6px solid #2e2f31;
  border-bottom: 6px solid #2e2f31;
}

/* Container */
/* QToolBox (Accordion) — consolidated */
QToolBox {
  border: 1px solid #444;
  border-radius: 6px;
  background: #414042;
  padding-top: 0px;
  color: rgb(255,255,255); /* ensure text shows */
}

/* Tab headers */
QToolBox::tab {
  background: #363436;
  color: rgb(255,255,255);
  border: 1px solid #444;
  border-bottom: none;

  /* IMPORTANT: let text have room */
  height: 28px;              /* was height: 10px — remove that */
  padding: 0 14px;

  font-size: 9pt;
  font-weight: 600;
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;

  /* spacing around tabs */
  margin: 4px 6px 2px 6px;

  /* if icons exist, keep them small so text stays visible */
  qproperty-iconSize: 16px 16px;
}

QToolBox::tab:hover {
  background: #4a4a4a;
  color: rgb(255,255,255);
}

QToolBox::tab:selected {
  background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #cc5500, stop:1 #993d00);
  color: rgb(255,255,255);
  font-weight: 700;
  margin-bottom: 2px; /* tighter */
}
"""

# Orange Progress Dialog styling for Generative Art
PROGRESS_DIALOG_QSS = """
QProgressDialog {
    background: #414042;
    color: #fff;
}
QProgressDialog QLabel {
    color: #fff;
    font-size: 11pt;
}
QProgressBar {
    border: 1px solid #666;
    border-radius: 4px;
    background: #363436;
    text-align: center;
    color: #fff;
    height: 22px;
}
QProgressBar::chunk {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #cc5500, stop:1 #ff7700);
    border-radius: 3px;
}
QPushButton {
    background: #cc5500;
    color: #fff;
    border: none;
    padding: 6px 18px;
    border-radius: 3px;
    font-weight: bold;
}
QPushButton:hover {
    background: #ff7700;
}
"""

def create_orange_progress(parent, title: str, maximum: int = 100) -> QProgressDialog:
    """Create an orange-styled progress dialog matching the accordion theme"""
    progress = QProgressDialog(title, "Cancel", 0, maximum, parent)
    progress.setWindowTitle("Generating...")
    progress.setModal(True)
    progress.setStyleSheet(PROGRESS_DIALOG_QSS)
    progress.setMinimumWidth(400)
    progress.setMinimumDuration(0)  # Show immediately
    progress.setValue(0)
    return progress

def resource_path(rel: str) -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        base = sys._MEIPASS  # type: ignore
    else:
        base = os.path.abspath(os.path.dirname(__file__))
    return os.path.join(base, rel)

def _load_app_icon() -> Optional[QIcon]:
    candidates = [ICON_PATH, resource_path("halftone_cmyk.ico")]
    for pth in candidates:
        try:
            if pth and os.path.isfile(pth):
                ic = QIcon(pth)
                if not ic.isNull():
                    return ic
        except Exception:
            pass
    return None

def pil_to_qpixmap(pil_img: Image.Image) -> QPixmap:
    if pil_img.mode != "RGBA":
        pil_img = pil_img.convert("RGBA")
    w, h = pil_img.size
    data = pil_img.tobytes("raw", "RGBA")
    qimg = QImage(data, w, h, 4 * w, QImage.Format.Format_RGBA8888)  # type: ignore
    # .copy() ensures pixel data is deep-copied before the 'data' buffer can be GC'd
    return QPixmap.fromImage(qimg.copy())

def load_image_capped(path: str) -> Image.Image:
    im = Image.open(path)
    
    # Preserve alpha channel for layer transparency support
    if im.mode == 'RGBA':
        pass  # Already RGBA with alpha preserved
    elif im.mode in ('LA', 'PA', 'P'):
        im = im.convert('RGBA')
    else:
        im = im.convert('RGBA')
    
    w, h = im.size
    long_side = max(w, h)
    if long_side > MAX_LONG_SIDE:
        s = MAX_LONG_SIDE / long_side
        im = im.resize((int(w*s), int(h*s)), Image.Resampling.LANCZOS)
    return im

def find_cmyk_icc() -> Optional[str]:
    env = os.environ.get("CMYK_ICC")
    if env and os.path.isfile(env): return env
    here = os.path.abspath(os.path.dirname(sys.argv[0] if getattr(sys, 'frozen', False) else __file__))
    for name in ("cmyk.icc","USWebCoatedSWOP.icc","CoatedFOGRA39.icc","GRACoL2006_Coated1v2.icc"):
        p = os.path.join(here, name)
        if os.path.isfile(p): return p
    if sys.platform.startswith("win"):
        search = [r"C:\Windows\System32\spool\drivers\color"]
    else:
        search = ["/Library/ColorSync/Profiles","/System/Library/ColorSync/Profiles"]
    for folder in search:
        try:
            for fn in os.listdir(folder):
                if fn.lower().endswith((".icc",".icm")) and any(k in fn.lower() for k in ("swop","gracol","fogra","cmyk")):
                    return os.path.join(folder, fn)
        except Exception:
            pass
    return None

_icc_xform_cache: dict = {}

def rgba_to_cmyk_with_icc(img_rgba: Image.Image, icc_path_opt: Optional[str] = None) -> Image.Image:
    if not HAS_CMS or ImageCms is None: return img_rgba.convert("CMYK")
    try:
        icc_path = icc_path_opt or find_cmyk_icc()
        cache_key = icc_path or "__default__"
        xform = _icc_xform_cache.get(cache_key)
        if xform is None:
            srgb = ImageCms.createProfile("sRGB")
            if icc_path and os.path.isfile(icc_path):
                cmyk = ImageCms.getOpenProfile(icc_path)
            else:
                cmyk = ImageCms.createProfile("CMYK")  # pyright: ignore[reportArgumentType]
            xform = ImageCms.buildTransformFromOpenProfiles(srgb, cmyk, "RGBA", "CMYK", renderingIntent=0)  # type: ignore
            _icc_xform_cache[cache_key] = xform
        result = ImageCms.applyTransform(img_rgba, xform)
        if result is None:
            return img_rgba.convert("CMYK")
        return result
    except Exception:
        return img_rgba.convert("CMYK")

# ============================================================================
# SIMPLEX NOISE IMPLEMENTATION (NumPy-only, no external dependencies)
# Based on Stefan Gustavson's simplex noise algorithm
# ============================================================================

# Gradient vectors for 2D simplex noise
_GRAD2 = np.array([
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1]
], dtype=np.float32)

# Permutation table (will be shuffled based on seed)
_PERM_BASE = np.arange(256, dtype=np.int32)

def _simplex_noise_2d(x: np.ndarray, y: np.ndarray, seed: int = 0) -> np.ndarray:
    """
    Generate 2D simplex noise for arrays of x, y coordinates.
    Returns values in range [-1, 1].
    """
    # Create seeded permutation table
    rng = np.random.default_rng(seed)
    perm = rng.permutation(_PERM_BASE)
    perm = np.tile(perm, 2)  # Double it to avoid overflow
    
    # Skewing factors for 2D
    F2 = 0.5 * (np.sqrt(3.0) - 1.0)
    G2 = (3.0 - np.sqrt(3.0)) / 6.0
    
    # Skew input space to determine simplex cell
    s = (x + y) * F2
    i = np.floor(x + s).astype(np.int32)
    j = np.floor(y + s).astype(np.int32)
    
    t = (i + j) * G2
    X0 = i - t  # Unskew cell origin back to (x,y) space
    Y0 = j - t
    x0 = x - X0  # Distances from cell origin
    y0 = y - Y0
    
    # Determine which simplex we're in
    i1 = np.where(x0 > y0, 1, 0)
    j1 = np.where(x0 > y0, 0, 1)
    
    # Offsets for corners
    x1 = x0 - i1 + G2
    y1 = y0 - j1 + G2
    x2 = x0 - 1.0 + 2.0 * G2
    y2 = y0 - 1.0 + 2.0 * G2
    
    # Hash coordinates of corners
    ii = i & 255
    jj = j & 255
    
    gi0 = perm[ii + perm[jj]] % 8
    gi1 = perm[ii + i1 + perm[jj + j1]] % 8
    gi2 = perm[ii + 1 + perm[jj + 1]] % 8
    
    # Calculate contributions from three corners
    def _contribution(gx, gy, dx, dy):
        t = 0.5 - dx*dx - dy*dy
        t = np.maximum(t, 0)
        t2 = t * t
        return t2 * t2 * (gx * dx + gy * dy)
    
    n0 = _contribution(_GRAD2[gi0, 0], _GRAD2[gi0, 1], x0, y0)
    n1 = _contribution(_GRAD2[gi1, 0], _GRAD2[gi1, 1], x1, y1)
    n2 = _contribution(_GRAD2[gi2, 0], _GRAD2[gi2, 1], x2, y2)
    
    # Scale to [-1, 1]
    return 70.0 * (n0 + n1 + n2)


def _fbm_noise_2d(x: np.ndarray, y: np.ndarray, octaves: int = 4, 
                  persistence: float = 0.5, lacunarity: float = 2.0, seed: int = 0) -> np.ndarray:
    """
    Fractal Brownian Motion - layered simplex noise for more natural patterns.
    """
    result = np.zeros_like(x)
    amplitude = 1.0
    frequency = 1.0
    max_value = 0.0
    
    for i in range(octaves):
        result += amplitude * _simplex_noise_2d(x * frequency, y * frequency, seed + i * 1000)
        max_value += amplitude
        amplitude *= persistence
        frequency *= lacunarity
    
    return result / max_value


def _generate_flow_field_lines(width: int, height: int, p, arr: Optional[np.ndarray] = None,
                                channel_seed: int = 0, progress_callback=None) -> List[List[Tuple[float, float]]]:
    """
    Generate flow field lines based on simplex noise, optionally influenced by image brightness.
    Returns list of polylines (each polyline is list of (x, y) points).
    """
    lines = []
    
    # Parameters from Params object
    noise_scale = p.flow_noise_scale
    line_density = p.flow_line_density / 100.0  # Convert to fraction
    line_length = int(p.flow_line_length * 2)  # Number of steps
    step_size = p.flow_step_size
    angle_offset = np.radians(p.flow_angle_offset)
    image_influence = p.flow_image_influence / 100.0
    turbulence = p.flow_turbulence / 100.0
    
    # Grid spacing based on density
    spacing = max(5, int(50 / max(0.1, line_density)))
    
    # Create coordinate grids for noise sampling
    seed = 42 + channel_seed
    
    # Pre-calculate total for progress
    y_positions = list(range(0, height, spacing))
    x_positions = list(range(0, width, spacing))
    total_points = len(y_positions) * len(x_positions)
    point_count = 0
    
    for start_y in y_positions:
        for start_x in x_positions:
            # Progress callback every 100 points
            if progress_callback and point_count % 100 == 0:
                progress_callback(int(point_count * 100 / max(1, total_points)))
            point_count += 1
            
            # Add some randomness to start positions
            rng = np.random.default_rng(seed + start_x * 1000 + start_y)
            sx = start_x + rng.uniform(-spacing/3, spacing/3)
            sy = start_y + rng.uniform(-spacing/3, spacing/3)
            
            line = [(sx, sy)]
            x, y = sx, sy
            
            for _ in range(line_length):
                if x < 0 or x >= width or y < 0 or y >= height:
                    break
                
                # Get noise value for angle
                nx = x / noise_scale
                ny = y / noise_scale
                
                # Use simplified noise calculation for individual points
                noise_val = _simplex_noise_2d(
                    np.array([nx], dtype=np.float32),
                    np.array([ny], dtype=np.float32),
                    seed=seed
                )[0]
                
                # Add turbulence
                if turbulence > 0:
                    turb = _simplex_noise_2d(
                        np.array([nx * 3], dtype=np.float32),
                        np.array([ny * 3], dtype=np.float32),
                        seed=seed + 9999
                    )[0]
                    noise_val += turb * turbulence
                
                # Convert to angle
                angle = noise_val * np.pi + angle_offset
                
                # Apply image influence if available
                if arr is not None and image_influence > 0:
                    ix, iy = int(x), int(y)
                    if 0 <= ix < width and 0 <= iy < height:
                        brightness = arr[iy, ix]
                        # Modulate angle based on brightness gradient
                        angle += brightness * np.pi * image_influence
                
                # Move along flow direction
                dx = np.cos(angle) * step_size
                dy = np.sin(angle) * step_size
                x += dx
                y += dy
                line.append((x, y))
            
            if len(line) > 2:
                lines.append(line)
    
    return lines


def _generate_spirograph(width: int, height: int, p, channel_seed: int = 0) -> List[List[Tuple[float, float]]]:
    """
    Generate spirograph/guilloche curves using parametric equations.
    Hypotrochoid: x = (R-r)*cos(t) + d*cos((R-r)/r * t)
                  y = (R-r)*sin(t) - d*sin((R-r)/r * t)
    """
    lines = []
    
    R = p.spiro_R
    r = p.spiro_r
    d = p.spiro_d
    num_curves = p.spiro_num_curves
    rotation_step = np.radians(p.spiro_rotation)
    scale = p.spiro_scale / 100.0
    complexity = p.spiro_complexity
    
    # Center of the canvas
    cx, cy = width / 2, height / 2
    
    # Calculate how many rotations needed to complete the pattern
    # GCD determines the number of lobes
    from math import gcd
    g = gcd(int(R), int(r)) if r > 0 else 1
    num_rotations = int(r / g) if g > 0 else 10
    num_rotations = int(num_rotations * complexity / 50)  # Scale by complexity
    num_rotations = max(1, min(num_rotations, 200))
    
    # Points per rotation
    points_per_rotation = 100
    total_points = num_rotations * points_per_rotation
    
    rng = np.random.default_rng(channel_seed)
    
    for curve_idx in range(num_curves):
        line = []
        curve_rotation = curve_idx * rotation_step + rng.uniform(0, 0.1)
        
        # Vary parameters slightly for each curve
        R_var = R * (1 + rng.uniform(-0.05, 0.05) * (curve_idx / max(1, num_curves - 1)))
        r_var = r * (1 + rng.uniform(-0.05, 0.05) * (curve_idx / max(1, num_curves - 1)))
        d_var = d * (1 + rng.uniform(-0.1, 0.1) * (curve_idx / max(1, num_curves - 1)))
        
        for i in range(total_points):
            t = (i / points_per_rotation) * 2 * np.pi
            
            if r_var != 0:
                # Hypotrochoid
                ratio = (R_var - r_var) / r_var
                x = (R_var - r_var) * np.cos(t) + d_var * np.cos(ratio * t)
                y = (R_var - r_var) * np.sin(t) - d_var * np.sin(ratio * t)
            else:
                # Fallback to circle
                x = R_var * np.cos(t)
                y = R_var * np.sin(t)
            
            # Apply rotation
            cos_r, sin_r = np.cos(curve_rotation), np.sin(curve_rotation)
            x_rot = x * cos_r - y * sin_r
            y_rot = x * sin_r + y * cos_r
            
            # Scale and translate to canvas center
            x_final = cx + x_rot * scale
            y_final = cy + y_rot * scale
            
            line.append((x_final, y_final))
        
        if len(line) > 2:
            lines.append(line)
    
    return lines


def _generate_reaction_diffusion(width: int, height: int, p, channel_seed: int = 0,
                                  use_gpu: bool = False, preview_mode: bool = False,
                                  progress_callback=None) -> np.ndarray:
    """
    Generate reaction-diffusion pattern using Gray-Scott model.
    Returns a binary/threshold array.
    preview_mode uses fewer iterations for faster preview.
    
    Gray-Scott equations:
    dA/dt = Da * laplacian(A) - A*B^2 + f*(1-A)
    dB/dt = Db * laplacian(B) + A*B^2 - (k+f)*B
    """
    # Scale down for performance
    scale = p.rd_scale / 100.0
    sim_w = max(64, int(width * scale / 4))
    sim_h = max(64, int(height * scale / 4))
    
    # Parameters
    Da = p.rd_diffusion_a  # Diffusion rate A
    Db = p.rd_diffusion_b  # Diffusion rate B
    f = p.rd_feed_rate / 1000.0  # Feed rate
    k = p.rd_kill_rate / 1000.0  # Kill rate
    iterations = p.rd_iterations if not preview_mode else min(200, p.rd_iterations // 5)
    threshold = p.rd_threshold / 100.0
    
    # Choose computation backend
    if use_gpu and HAS_CUPY and cp is not None:
        xp = cp
    else:
        xp = np
    
    # Initialize grids
    rng = np.random.default_rng(channel_seed)
    A = xp.ones((sim_h, sim_w), dtype=xp.float32)
    B = xp.zeros((sim_h, sim_w), dtype=xp.float32)
    
    # Seed with random patches
    num_seeds = max(3, int(sim_w * sim_h / 1000))
    for _ in range(num_seeds):
        cx = rng.integers(10, sim_w - 10)
        cy = rng.integers(10, sim_h - 10)
        size = rng.integers(3, 8)
        B[cy-size:cy+size, cx-size:cx+size] = 1.0
        A[cy-size:cy+size, cx-size:cx+size] = 0.5
    
    # Laplacian kernel (discrete approximation)
    def laplacian(arr):
        # Using convolution-like operation for discrete laplacian
        result = -arr * 4
        result += xp.roll(arr, 1, axis=0)  # Up
        result += xp.roll(arr, -1, axis=0)  # Down
        result += xp.roll(arr, 1, axis=1)  # Left
        result += xp.roll(arr, -1, axis=1)  # Right
        return result
    
    # Run simulation
    dt = 1.0
    for i in range(iterations):
        # Progress callback every 25 iterations
        if progress_callback and i % 25 == 0:
            progress_callback(int(i * 100 / max(1, iterations)))
        
        lap_A = laplacian(A)
        lap_B = laplacian(B)
        
        AB2 = A * B * B
        
        A += (Da * lap_A - AB2 + f * (1 - A)) * dt
        B += (Db * lap_B + AB2 - (k + f) * B) * dt
        
        # Clamp values
        A = xp.clip(A, 0, 1)
        B = xp.clip(B, 0, 1)
    
    # Convert back to numpy if using GPU
    if use_gpu and HAS_CUPY and cp is not None:
        B = cp.asnumpy(B)
    
    # Threshold to create binary pattern
    result = (B > threshold).astype(np.float32)
    
    # Scale up to output size
    from PIL import Image
    result_img = Image.fromarray((result * 255).astype(np.uint8))
    result_img = result_img.resize((width, height), Image.Resampling.LANCZOS)
    
    return np.array(result_img, dtype=np.float32) / 255.0


def _rd_to_contour_lines(rd_array: np.ndarray, p) -> List[List[Tuple[float, float]]]:
    """
    Convert reaction-diffusion binary array to contour lines for vector output.
    Uses marching squares algorithm.
    """
    lines = []
    h, w = rd_array.shape
    threshold = 0.5
    
    # Simple marching squares implementation
    for y in range(h - 1):
        for x in range(w - 1):
            # Get cell corner values
            tl = rd_array[y, x]
            tr = rd_array[y, x + 1]
            bl = rd_array[y + 1, x]
            br = rd_array[y + 1, x + 1]
            
            # Calculate cell index
            idx = 0
            if tl > threshold: idx |= 1
            if tr > threshold: idx |= 2
            if br > threshold: idx |= 4
            if bl > threshold: idx |= 8
            
            # Skip empty and full cells
            if idx == 0 or idx == 15:
                continue
            
            # Linear interpolation for edge crossing points
            def interp(v1, v2, y1, x1, y2, x2):
                if abs(v2 - v1) < 0.001:
                    t = 0.5
                else:
                    t = (threshold - v1) / (v2 - v1)
                return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
            
            # Generate line segments based on cell configuration
            segments = []
            if idx in [1, 14]:
                segments.append([interp(tl, tr, y, x, y, x+1), interp(tl, bl, y, x, y+1, x)])
            elif idx in [2, 13]:
                segments.append([interp(tl, tr, y, x, y, x+1), interp(tr, br, y, x+1, y+1, x+1)])
            elif idx in [4, 11]:
                segments.append([interp(tr, br, y, x+1, y+1, x+1), interp(bl, br, y+1, x, y+1, x+1)])
            elif idx in [8, 7]:
                segments.append([interp(tl, bl, y, x, y+1, x), interp(bl, br, y+1, x, y+1, x+1)])
            elif idx in [3, 12]:
                segments.append([interp(tl, bl, y, x, y+1, x), interp(tr, br, y, x+1, y+1, x+1)])
            elif idx in [6, 9]:
                segments.append([interp(tl, tr, y, x, y, x+1), interp(bl, br, y+1, x, y+1, x+1)])
            elif idx == 5:
                segments.append([interp(tl, tr, y, x, y, x+1), interp(tl, bl, y, x, y+1, x)])
                segments.append([interp(tr, br, y, x+1, y+1, x+1), interp(bl, br, y+1, x, y+1, x+1)])
            elif idx == 10:
                segments.append([interp(tl, tr, y, x, y, x+1), interp(tr, br, y, x+1, y+1, x+1)])
                segments.append([interp(tl, bl, y, x, y+1, x), interp(bl, br, y+1, x, y+1, x+1)])
            
            for seg in segments:
                if len(seg) == 2:
                    lines.append(seg)
    
    return lines


def _generate_geometric_flow(w: int, h: int, p, 
                              arr: Optional[np.ndarray] = None,
                              channel_seed: int = 0,
                              progress_callback=None) -> List[Dict]:
    """
    Generate geometric shapes positioned along a flow field.
    Returns list of dicts with: {type, cx, cy, size, angle, points}
    """
    import random
    random.seed(42 + channel_seed)
    np.random.seed(42 + channel_seed)
    
    shapes = []
    
    # Calculate spacing to fit the requested number of shapes
    # spacing slider (5-100%) controls density - lower = denser
    avg_size = (p.geoflow_size_min + p.geoflow_size_max) / 2
    # Base spacing on shape size, with spacing slider as multiplier
    spacing_multiplier = 0.5 + (p.geoflow_spacing / 100) * 2.5  # Range: 0.55 to 3.0
    spacing = max(10, int(avg_size * spacing_multiplier))
    
    # Create grid of potential positions with jitter
    positions = []
    for y in range(spacing // 2, h, spacing):
        for x in range(spacing // 2, w, spacing):
            # Add turbulence/jitter
            jitter = p.geoflow_turbulence * spacing / 100
            jx = x + random.uniform(-jitter, jitter)
            jy = y + random.uniform(-jitter, jitter)
            if 0 <= jx < w and 0 <= jy < h:
                positions.append((jx, jy))
    
    # Limit to count
    if len(positions) > p.geoflow_count:
        positions = random.sample(positions, p.geoflow_count)
    
    total = len(positions)
    noise_scale = max(1, p.geoflow_noise_scale)
    
    for idx, (cx, cy) in enumerate(positions):
        if progress_callback and idx % 20 == 0:
            progress_callback(int(idx * 100 / max(1, total)))
        
        # Get flow angle at this position using simplex noise
        nx, ny = cx / noise_scale, cy / noise_scale
        # _simplex_noise_2d expects arrays, so wrap scalars
        noise_val = _simplex_noise_2d(np.array([nx]), np.array([ny]))[0]
        angle = noise_val * np.pi + np.radians(p.geoflow_angle_offset)
        
        # Optional: modulate by image if available
        if arr is not None and p.flow_image_influence > 0:
            ix, iy = int(cx), int(cy)
            if 0 <= ix < w and 0 <= iy < h:
                img_val = arr[iy, ix]
                img_angle = img_val * np.pi * 2
                influence = p.flow_image_influence / 100
                angle = angle * (1 - influence) + img_angle * influence
        
        # Size - random between min and max, optionally by flow strength
        base_size = random.uniform(p.geoflow_size_min, p.geoflow_size_max)
        if p.geoflow_size_by_flow:
            flow_strength = abs(_simplex_noise_2d(np.array([nx * 2]), np.array([ny * 2]))[0])
            base_size *= 0.5 + flow_strength
        
        # Generate shape points
        shape_type = p.geoflow_shape
        points = _get_shape_points(shape_type, cx, cy, base_size, 
                                   angle if p.geoflow_rotation else 0)
        
        shapes.append({
            'type': shape_type,
            'cx': cx,
            'cy': cy,
            'size': base_size,
            'angle': angle if p.geoflow_rotation else 0,
            'points': points
        })
    
    return shapes


def _get_shape_points(shape_type: str, cx: float, cy: float, size: float, angle: float) -> List:
    """Generate polygon points for a shape centered at (cx, cy) with given size and rotation"""
    half = size / 2
    
    if shape_type == "circle":
        # Return center and radius for circles (special case)
        return [('circle', cx, cy, half)]
    
    elif shape_type == "square":
        corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
    
    elif shape_type == "triangle":
        # Equilateral triangle
        h_tri = size * np.sqrt(3) / 2
        corners = [(0, -h_tri * 2/3), (half, h_tri / 3), (-half, h_tri / 3)]
    
    elif shape_type == "hexagon":
        corners = []
        for i in range(6):
            a = np.pi / 3 * i - np.pi / 2
            corners.append((half * np.cos(a), half * np.sin(a)))
    
    elif shape_type == "diamond":
        corners = [(0, -half), (half, 0), (0, half), (-half, 0)]
    
    elif shape_type == "star":
        corners = []
        for i in range(10):
            a = np.pi / 5 * i - np.pi / 2
            r = half if i % 2 == 0 else half * 0.4
            corners.append((r * np.cos(a), r * np.sin(a)))
    
    else:  # default to square for "custom" or unknown
        corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
    
    # Rotate and translate
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    points = []
    for px, py in corners:
        rx = px * cos_a - py * sin_a + cx
        ry = px * sin_a + py * cos_a + cy
        points.append((rx, ry))
    
    return points


@dataclass
class Params:
    mode: str
    cell: float
    elem: float
    stroke: float
    smoothing_pct: float
    preview_channel: str
    ang_c: float
    ang_m: float
    ang_y: float
    ang_k: float
    full_composite_preview: bool
    regs_on: bool
    reg_size_px: float
    reg_offset_px: float
    reg_thickness_pct: float
    grayscale_mode: bool
    invert_gray: bool
    warp_amt: float
    warp_scale: float
    slice_shift_amt: int
    vertical_slice_shift_amt: int
    halftone_slice_shift_amt: int
    halftone_vertical_slice_shift_amt: int
    displace_c: Tuple[int, int]
    displace_m: Tuple[int, int]
    displace_y: Tuple[int, int]
    displace_k: Tuple[int, int]
    # Diffusion parameters
    diffusion_enabled: bool
    diffusion_algorithm: str
    diffusion_intensity: float
    diffusion_levels: int
    diffusion_sharpen_strength: float
    diffusion_sharpen_radius: float
    diffusion_denoise: float
    diffusion_modulation: str
    diffusion_mod_strength: float
    # Diffusion glitch effects
    broken_kernel: float
    directional_bias: float
    directional_bias_angle: float
    error_overflow: float
    diffusion_reset: float
    cross_channel_bleed: float
    # Datamosh effects
    smear_drag: float
    smear_length: int
    smear_vertical: bool
    macroblock_corrupt: float
    macroblock_dropout: float
    block_shift: float
    block_shift_size: int
    channel_desync: float
    bitmap_sort: float
    bitmap_sort_vertical: bool
    
    # Hatching control parameters
    line_length_pct: float
    line_width_pct: float
    line_weight_variation: float
    line_density_pct: float
    line_taper_pct: float
    stroke_randomness: float
    cross_hatching_enabled: bool
    cross_hatching_angle: float
    hatching_invert: bool
    cross_hatch_threshold: float = 40.0  # Percentage threshold for cross-hatching
    dot_gap: float = 0.0  # Gap between dots (always 0 for SVG export)
    slice_size_px: int = 20           # Height of each horizontal slice band (px)
    slice_angle: float = 0.0          # Angle of horizontal slice bands (degrees)
    vertical_slice_size_px: int = 20  # Width of each vertical slice band (px)
    vertical_slice_angle: float = 0.0  # Angle of vertical slice bands (degrees)
    # Lines flow path parameters
    lines_flow_path: Optional[List[Tuple[float, float]]] = None  # User-drawn path points (artboard coords)
    lines_use_flow_path: bool = False  # Enable flow path direction for lines
    lines_path_influence: float = 100.0  # How strongly path affects line angle (0-100%)
    # ASCII Art parameters
    ascii_enabled: bool = False
    ascii_charset: str = "default"  # Preset character sets
    ascii_custom_chars: str = ""    # Custom characters from light to dark
    ascii_cell_size: float = 10.0   # Size of each ASCII cell in pixels
    ascii_invert: bool = False      # Invert tonal mapping
    ascii_threshold_levels: int = 10  # Number of threshold levels
    ascii_font_size: float = 10.0   # Font size for rendering
    ascii_line_spacing: float = 1.0 # Line spacing multiplier
    ascii_keep_text_editable: bool = False  # SVG: use <text> instead of paths
    # CMYK Pixelate parameters
    pixelate_enabled: bool = False
    pixelate_block_size: int = 20   # pixel block size (4-120)
    # Generative Art parameters
    generative_enabled: bool = False
    generative_mode: str = "flow fields"  # "flow fields", "spirograph", "reaction-diffusion"
    generative_invert: bool = False
    generative_per_channel: bool = False  # True = separate pattern per CMYK channel
    # Flow Fields parameters
    flow_noise_scale: float = 100.0  # Noise zoom level (higher = larger features)
    flow_line_density: float = 50.0  # Spacing between flow lines (%)
    flow_line_length: float = 50.0   # How far each line travels (%)
    flow_step_size: float = 2.0      # Smoothness of curves (px per step)
    flow_angle_offset: float = 0.0   # Rotate entire field (degrees)
    flow_image_influence: float = 50.0  # 0% = pure noise, 100% = follows image
    flow_turbulence: float = 0.0     # Add chaos to field (%)
    flow_line_width: float = 1.0     # Stroke width for flow lines
    # Spirograph/Guilloche parameters
    spiro_R: float = 100.0           # Outer circle radius
    spiro_r: float = 40.0            # Inner circle radius  
    spiro_d: float = 30.0            # Drawing point distance from inner center
    spiro_num_curves: int = 3        # Number of overlapping curves
    spiro_rotation: float = 0.0      # Rotation between curves (degrees)
    spiro_line_width: float = 1.0    # Stroke width
    spiro_scale: float = 100.0       # Overall scale (%)
    spiro_complexity: float = 50.0   # Number of rotations to complete pattern
    # Reaction-Diffusion parameters
    rd_feed_rate: float = 0.055      # Feed rate (F) - controls pattern type
    rd_kill_rate: float = 0.062      # Kill rate (k) - controls pattern type
    rd_iterations: int = 1000        # Simulation steps (more = more defined)
    rd_scale: float = 100.0          # Pattern scale (%)
    rd_threshold: float = 50.0       # Threshold for converting to binary (%)
    rd_diffusion_a: float = 1.0      # Diffusion rate of chemical A
    rd_diffusion_b: float = 0.5      # Diffusion rate of chemical B
    rd_line_width: float = 1.0       # Stroke width for contours
    rd_use_gpu: bool = False         # Use GPU acceleration if available
    # Geometric Flow parameters
    geoflow_shape: str = "circle"    # "circle", "square", "triangle", "hexagon", "custom"
    geoflow_count: int = 100         # Number of shapes
    geoflow_size_min: float = 10.0   # Minimum shape size (px)
    geoflow_size_max: float = 50.0   # Maximum shape size (px)
    geoflow_noise_scale: float = 100.0  # Flow field noise scale
    geoflow_rotation: bool = True    # Rotate shapes along flow direction
    geoflow_size_by_flow: bool = False  # Scale size by flow field strength
    geoflow_fill: bool = True        # Fill shapes (vs stroke only)
    geoflow_spacing: float = 50.0    # Spacing between shapes (%)
    geoflow_angle_offset: float = 0.0  # Global rotation offset (degrees)
    geoflow_turbulence: float = 0.0  # Add chaos to positions (%)
    generative_line_width: float = 1.0  # Global line width for generative art
    # Stereogram fields
    stereogram_mode: bool = False
    stereo_depth_intensity: int = 50
    stereo_separation: int = 60
    stereo_smooth_depth: int = 30
    stereo_invert_depth: bool = False
    stereo_num_colors: int = 3
    stereo_dot_size: int = 4
    stereo_fray_x_edge: int = 0
    stereo_fray_y_edge: int = 0
    stereo_pattern: str = "random dots"
    stereo_pattern_offset: int = 0
    stereo_color_c: str = "#00FFFF"
    stereo_color_m: str = "#FF00FF"
    stereo_color_y: str = "#FFFF00"
    stereo_color_k: str = "#000000"

@dataclass
class Transform:
    scale_pct: int
    offset_x_px: int
    offset_y_px: int
    orientation: str

@dataclass
class Layer:
    name: str
    image: Image.Image
    visible: bool = True
    locked: bool = False
    offset_x: int = 0
    offset_y: int = 0
    scale_pct: int = 100
    opacity: float = 1.0
    effect_params: Optional['Params'] = None  # Per-layer effect settings

class PreviewArea(QLabel):
    # Signal emitted when flow path drawing is complete
    flowPathChanged = Signal(list)  # Emits list of (x, y) tuples in artboard coords
    
    def __init__(self, main_window, on_wheel, on_drag_delta, get_art_size_px):
        super().__init__()
        self.main_window = main_window
        self.on_wheel = on_wheel
        self.on_drag_delta = on_drag_delta
        self.get_art_size_px = get_art_size_px
        self.setObjectName("PreviewArea")
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._dragging = False
        self._last_pos: Optional[QPoint] = None
        self._pixmap: Optional[QPixmap] = None
        # Set cursor to open hand to indicate grab/pan functionality
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        self.zoom_scale: float = 1.0
        # Viewport pan offsets (widget pixels)
        self._view_pan_x: float = 0.0
        self._view_pan_y: float = 0.0
        
        # Flow path drawing state
        self._drawing_flow_path = False  # True when in draw mode
        self._flow_path_active = False   # True during active mouse drag
        self._flow_path_points: List[Tuple[float, float]] = []  # Points in artboard coords
        self._show_flow_path = True      # Toggle path visibility
        self._pixmap_scale: float = 1.0  # Factor: pixmap_size = artboard_size * _pixmap_scale

    def setPixmap(self, pm: QPixmap | QImage, pixmap_scale: float = 1.0):
        if isinstance(pm, QImage):
            self._pixmap = QPixmap.fromImage(pm)
        else:
            self._pixmap = pm
        self._pixmap_scale = max(0.01, float(pixmap_scale))
        self.update()

    def set_zoom(self, z: float):
        self.zoom_scale = max(0.1, min(4.0, float(z)))
        self._view_pan_x = 0.0
        self._view_pan_y = 0.0
        self.update()
    
    def set_flow_path_draw_mode(self, enabled: bool):
        """Enable or disable flow path drawing mode."""
        self._drawing_flow_path = enabled
        if enabled:
            self.setCursor(Qt.CursorShape.CrossCursor)
        else:
            self.setCursor(Qt.CursorShape.OpenHandCursor)
    
    def set_show_flow_path(self, show: bool):
        """Toggle flow path visibility."""
        self._show_flow_path = show
        self.update()
    
    def clear_flow_path(self):
        """Clear the current flow path."""
        self._flow_path_points = []
        self.flowPathChanged.emit([])
        self.update()
    
    def set_flow_path(self, points: List[Tuple[float, float]]):
        """Set flow path from external source (e.g., loaded preset)."""
        self._flow_path_points = list(points) if points else []
        self.update()
    
    def _widget_to_artboard(self, widget_pos: QPoint) -> Tuple[float, float]:
        """Convert widget coordinates to artboard coordinates."""
        if self._pixmap is None or self._pixmap.isNull():
            return (0.0, 0.0)
        
        pm_w, pm_h = self._pixmap.width(), self._pixmap.height()
        z = self.zoom_scale / self._pixmap_scale
        draw_w, draw_h = int(pm_w * z), int(pm_h * z)
        label_w, label_h = self.width(), self.height()
        ox = (label_w - draw_w) // 2 + int(self._view_pan_x)
        oy = (label_h - draw_h) // 2 + int(self._view_pan_y)
        
        # Convert to pixmap coordinates, then to artboard
        px = (widget_pos.x() - ox) / z
        py = (widget_pos.y() - oy) / z
        
        # Get artboard size from main window
        art_w, art_h = self.get_art_size_px()
        
        # Scale from pixmap to artboard coordinates
        # The pixmap may be scaled relative to artboard
        if pm_w > 0 and pm_h > 0:
            ax = px * art_w / pm_w
            ay = py * art_h / pm_h
        else:
            ax, ay = px, py
        
        return (ax, ay)

    def wheelEvent(self, e):
        self.on_wheel(+1 if e.angleDelta().y() > 0 else -1)

    def mousePressEvent(self, e: QMouseEvent):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drawing_flow_path:
                # Start drawing flow path
                self._flow_path_active = True
                self._flow_path_points = []  # Clear existing path
                art_pos = self._widget_to_artboard(e.position().toPoint())
                self._flow_path_points.append(art_pos)
                self.update()
            else:
                # Normal panning behavior
                self._dragging = True
                self._last_pos = e.position().toPoint()
                self.setCursor(Qt.CursorShape.ClosedHandCursor)

    def mouseMoveEvent(self, e: QMouseEvent):
        if self._flow_path_active:
            # Add point to flow path (sample every few pixels for performance)
            art_pos = self._widget_to_artboard(e.position().toPoint())
            if self._flow_path_points:
                last = self._flow_path_points[-1]
                dist = math.sqrt((art_pos[0] - last[0])**2 + (art_pos[1] - last[1])**2)
                if dist >= 3:  # Minimum 3px spacing between samples
                    self._flow_path_points.append(art_pos)
                    self.update()
            else:
                self._flow_path_points.append(art_pos)
                self.update()
        elif self._dragging and self._last_pos is not None:
            cur = e.position().toPoint()
            dx = cur.x() - self._last_pos.x()
            dy = cur.y() - self._last_pos.y()
            self._last_pos = cur
            self.on_drag_delta(dx, dy)

    def mouseReleaseEvent(self, e: QMouseEvent):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._flow_path_active:
                self._flow_path_active = False
                # Smooth and emit the path if it has at least 2 points
                if len(self._flow_path_points) >= 2:
                    self._flow_path_points = self._smooth_path(self._flow_path_points)
                    self.flowPathChanged.emit(self._flow_path_points)
                else:
                    self._flow_path_points = []
                self.update()
            else:
                self._dragging = False
                self._last_pos = None
                self.setCursor(Qt.CursorShape.OpenHandCursor)
    
    def _smooth_path(self, points: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
        """Apply Catmull-Rom spline smoothing to the path with high density for smooth angles."""
        if len(points) < 3:
            return points
        
        # Catmull-Rom spline interpolation with higher density (2px spacing)
        smoothed = []
        # Extend endpoints for smooth start/end
        extended = [points[0]] + points + [points[-1]]
        
        for i in range(1, len(extended) - 2):
            p0 = extended[i - 1]
            p1 = extended[i]
            p2 = extended[i + 1]
            p3 = extended[i + 2]
            
            # Generate interpolated points between p1 and p2 (2px spacing for smooth tangents)
            segment_dist = math.sqrt((p2[0]-p1[0])**2 + (p2[1]-p1[1])**2)
            num_segments = max(3, int(segment_dist / 2))  # More points for smoother angles
            for t_idx in range(num_segments):
                t = t_idx / num_segments
                t2 = t * t
                t3 = t2 * t
                
                # Catmull-Rom coefficients
                x = 0.5 * ((2 * p1[0]) +
                          (-p0[0] + p2[0]) * t +
                          (2*p0[0] - 5*p1[0] + 4*p2[0] - p3[0]) * t2 +
                          (-p0[0] + 3*p1[0] - 3*p2[0] + p3[0]) * t3)
                y = 0.5 * ((2 * p1[1]) +
                          (-p0[1] + p2[1]) * t +
                          (2*p0[1] - 5*p1[1] + 4*p2[1] - p3[1]) * t2 +
                          (-p0[1] + 3*p1[1] - 3*p2[1] + p3[1]) * t3)
                smoothed.append((x, y))
        
        # Add final point
        smoothed.append(points[-1])
        return smoothed

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if hasattr(self, 'main_window') and hasattr(self.main_window, '_reposition_overlays'):
            self.main_window._reposition_overlays()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        path = QPainterPath()
        path.addRoundedRect(self.rect().adjusted(0, 0, -1, -1), 8, 8)
        p.setClipPath(path)
        if self._pixmap is None or self._pixmap.isNull():
            p.end(); return

        pm_w, pm_h = self._pixmap.width(), self._pixmap.height()
        # If pixmap was rendered at a reduced scale, compensate so it displays
        # at the same on-screen size as the full-res version would.
        z = self.zoom_scale / self._pixmap_scale
        draw_w, draw_h = int(pm_w*z), int(pm_h*z)
        label_w, label_h = self.width(), self.height()
        ox = (label_w - draw_w)//2 + int(self._view_pan_x)
        oy = (label_h - draw_h)//2 + int(self._view_pan_y)

        target = QRect(ox, oy, draw_w, draw_h)

        # ── Checkerboard behind artboard so transparency is visible ──
        _cs = 8
        _tile = QPixmap(_cs * 2, _cs * 2)
        _tile.fill(QColor(230, 230, 230))
        _tp = QPainter(_tile)
        _tp.fillRect(0, 0, _cs, _cs, QColor(200, 200, 200))
        _tp.fillRect(_cs, _cs, _cs, _cs, QColor(200, 200, 200))
        _tp.end()
        p.save()
        p.setBrush(QBrush(_tile))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawRect(target)
        p.restore()

        p.drawPixmap(target, self._pixmap)

        # Draw the artboard border to exactly match the pixmap being displayed.
        # This keeps the red border aligned during reduced-resolution previews.
        p.setPen(QPen(QColor(200,40,40,255), 2, Qt.PenStyle.SolidLine))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(target)
        
        # Draw flow path overlay if visible and has points
        if self._show_flow_path and len(self._flow_path_points) >= 2:
            self._draw_flow_path_overlay(p, pm_w, pm_h, ox, oy, z)
        
        p.end()
    
    def _draw_flow_path_overlay(self, painter: QPainter, pm_w: int, pm_h: int, 
                                  ox: int, oy: int, zoom: float):
        """Draw the flow path as orange dots spaced every 5px."""
        if not self._flow_path_points:
            return
        
        # Get artboard size for coordinate conversion
        art_w, art_h = self.get_art_size_px()
        if art_w <= 0 or art_h <= 0:
            return
        
        # Orange color matching accordion headers (#cc5500)
        orange = QColor(0xcc, 0x55, 0x00, 255)
        pen = QPen(orange)
        pen.setWidth(1)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.setBrush(orange)
        
        # Calculate total path length and draw dots at 5px intervals
        accumulated_dist = 0.0
        dot_spacing = 5.0  # Artboard pixels between dots
        
        for i in range(len(self._flow_path_points)):
            if i == 0:
                # Always draw first point
                ax, ay = self._flow_path_points[0]
                # Convert artboard coords to widget coords
                wx = ox + (ax / art_w) * pm_w * zoom
                wy = oy + (ay / art_h) * pm_h * zoom
                painter.drawEllipse(int(wx), int(wy), 1, 1)
                accumulated_dist = 0.0
            else:
                # Calculate distance from previous point
                prev = self._flow_path_points[i - 1]
                curr = self._flow_path_points[i]
                segment_dist = math.sqrt((curr[0] - prev[0])**2 + (curr[1] - prev[1])**2)
                
                # Draw dots along this segment at 5px intervals
                if segment_dist > 0:
                    # How far along the segment to start
                    start_offset = dot_spacing - accumulated_dist
                    if start_offset < 0:
                        start_offset = 0
                    
                    # Draw dots along this segment
                    t = start_offset
                    while t <= segment_dist:
                        # Interpolate position
                        ratio = t / segment_dist
                        ax = prev[0] + (curr[0] - prev[0]) * ratio
                        ay = prev[1] + (curr[1] - prev[1]) * ratio
                        
                        # Convert to widget coords
                        wx = ox + (ax / art_w) * pm_w * zoom
                        wy = oy + (ay / art_h) * pm_h * zoom
                        painter.drawEllipse(int(wx), int(wy), 1, 1)
                        t += dot_spacing
                    
                    # Update accumulated distance for next segment
                    accumulated_dist = segment_dist - (t - dot_spacing)
                    if accumulated_dist < 0:
                        accumulated_dist = 0

    def _get_transform(self):
        return self.main_window._get_transform()


# ------------------------------ stereogram core (optimized) ------------------------------
class StereogramCore:
    """High-performance stereogram generation with caching."""
    def __init__(self):
        self._depth_cache: Dict[int, np.ndarray] = {}
        self._depth_cache_max = 20
        self._pattern_strip_cache: Dict[Tuple, np.ndarray] = {}
        self._pattern_strip_cache_max = 10
        self._plates_cache: Dict[int, Dict] = {}
        self._plates_cache_max = 5
        self.interacting = False

    def _cache_put(self, cache: dict, key, value, max_size: int):
        if len(cache) >= max_size:
            oldest = next(iter(cache))
            del cache[oldest]
        cache[key] = value

    def process_depth_map(self, img_rgba: Image.Image, p: Params) -> np.ndarray:
        img_hash = hash((img_rgba.tobytes()[:1000], p.stereo_invert_depth,
                        p.stereo_smooth_depth))
        if img_hash in self._depth_cache:
            return self._depth_cache[img_hash]
        gray = img_rgba.convert("L")
        depth_array = np.array(gray, dtype=np.float32) / 255.0
        if p.stereo_invert_depth:
            depth_array = 1.0 - depth_array
        if p.stereo_smooth_depth > 0 and HAS_SCIPY and gaussian_filter is not None:
            sigma = p.stereo_smooth_depth / 10.0
            depth_array = gaussian_filter(depth_array, sigma=sigma)
        self._cache_put(self._depth_cache, img_hash, depth_array, self._depth_cache_max)
        return depth_array

    def _generate_pattern_strip(self, width: int, height: int, pattern: str,
                                 num_colors: int, pattern_offset: int = 0) -> np.ndarray:
        cache_key = (width, height, pattern, num_colors)
        if cache_key in self._pattern_strip_cache:
            base_strip = self._pattern_strip_cache[cache_key]
            if pattern_offset != 0 and pattern != "random dots":
                return np.roll(base_strip, pattern_offset, axis=0)
            return base_strip
        strip = np.zeros((height, width), dtype=np.uint8)
        if pattern == "random dots":
            np.random.seed(42 + pattern_offset)
            strip = np.random.randint(0, num_colors, (height, width), dtype=np.uint8)
        elif pattern == "horizontal lines":
            for y in range(height):
                strip[y, :] = y % num_colors
        elif pattern == "vertical lines":
            for x in range(width):
                strip[:, x] = x % num_colors
        elif pattern == "diagonal /":
            for y in range(height):
                for x in range(width):
                    strip[y, x] = (x + y) % num_colors
        elif pattern == "diagonal \\":
            for y in range(height):
                for x in range(width):
                    strip[y, x] = (x - y) % num_colors
        elif pattern == "checkerboard":
            for y in range(height):
                for x in range(width):
                    strip[y, x] = ((x // 2) + (y // 2)) % num_colors
        elif pattern == "grid":
            for y in range(height):
                for x in range(width):
                    if x % 4 == 0 or y % 4 == 0:
                        strip[y, x] = num_colors - 1
                    else:
                        strip[y, x] = ((x // 4) + (y // 4)) % (num_colors - 1) if num_colors > 1 else 0
        self._cache_put(self._pattern_strip_cache, cache_key, strip, self._pattern_strip_cache_max)
        if pattern_offset != 0 and pattern != "random dots":
            return np.roll(strip, pattern_offset, axis=0)
        return strip

    def generate_stereogram_multicolor(self, depth_map: np.ndarray, p: Params,
                                        random_seed: int = 42, pattern_offset: int = 0) -> np.ndarray:
        dot_size = p.stereo_dot_size
        height, width = depth_map.shape
        h_small = height // dot_size
        w_small = width // dot_size
        depth_small = depth_map[::dot_size, ::dot_size]
        if depth_small.shape != (h_small, w_small):
            depth_small = depth_small[:h_small, :w_small]
        separation = p.stereo_separation // dot_size
        depth_intensity = p.stereo_depth_intensity / 100.0
        num_colors = p.stereo_num_colors
        output_small = np.zeros((h_small, w_small), dtype=np.uint8)
        strip_width = max(1, separation)
        np.random.seed(random_seed)
        pattern_strip = self._generate_pattern_strip(strip_width, h_small,
                                                      p.stereo_pattern, num_colors, pattern_offset)
        output_small[:, :strip_width] = pattern_strip
        for x in range(strip_width, w_small):
            for y in range(h_small):
                depth_value = depth_small[y, x]
                shift = int(separation * depth_intensity * depth_value)
                source_x = x - separation + min(shift, x - 1)
                if 0 <= source_x < x:
                    output_small[y, x] = output_small[y, source_x]
                else:
                    output_small[y, x] = output_small[y, max(0, x - separation)]
        output = np.repeat(np.repeat(output_small, dot_size, axis=0), dot_size, axis=1)
        output = output[:height, :width]
        return output

    def _apply_fray_x_edge(self, arr: np.ndarray, fray_amount: int) -> np.ndarray:
        if fray_amount == 0:
            return arr
        h, w = arr.shape
        content_mask = arr > 0
        content_rows = np.any(content_mask, axis=1)
        content_cols = np.any(content_mask, axis=0)
        if not np.any(content_rows) or not np.any(content_cols):
            return arr
        top_idx = np.where(content_rows)[0][0]
        bottom_idx = np.where(content_rows)[0][-1]
        left_idx = np.where(content_cols)[0][0]
        right_idx = np.where(content_cols)[0][-1]
        out = arr.copy()
        max_shift = int(fray_amount * 1.5)
        fray_width = max(10, max_shift * 2)
        np.random.seed(42)
        for y in range(top_idx, bottom_idx + 1):
            shift = np.random.randint(-max_shift, max_shift + 1)
            if shift > 0:
                out[y, left_idx:left_idx + fray_width] = 0
        for y in range(top_idx, bottom_idx + 1):
            shift = np.random.randint(-max_shift, max_shift + 1)
            if shift < 0:
                out[y, max(0, right_idx - fray_width):right_idx + 1] = 0
        return out

    def _apply_fray_y_edge(self, arr: np.ndarray, fray_amount: int) -> np.ndarray:
        if fray_amount == 0:
            return arr
        h, w = arr.shape
        content_mask = arr > 0
        content_rows = np.any(content_mask, axis=1)
        content_cols = np.any(content_mask, axis=0)
        if not np.any(content_rows) or not np.any(content_cols):
            return arr
        top_idx = np.where(content_rows)[0][0]
        bottom_idx = np.where(content_rows)[0][-1]
        left_idx = np.where(content_cols)[0][0]
        right_idx = np.where(content_cols)[0][-1]
        out = arr.copy()
        max_shift = int(fray_amount * 1.5)
        fray_height = max(10, max_shift * 2)
        np.random.seed(43)
        for x in range(left_idx, right_idx + 1):
            shift = np.random.randint(-max_shift, max_shift + 1)
            if shift > 0:
                out[top_idx:top_idx + fray_height, x] = 0
        for x in range(left_idx, right_idx + 1):
            shift = np.random.randint(-max_shift, max_shift + 1)
            if shift < 0:
                out[max(0, bottom_idx - fray_height):bottom_idx + 1, x] = 0
        return out

    def separate_stereogram_to_plates(self, stereogram_colors: np.ndarray, p: Params) -> Dict[str, np.ndarray]:
        plates = {}
        plates['c'] = (stereogram_colors == 0).astype(np.uint8) * 255
        plates['m'] = (stereogram_colors == 1).astype(np.uint8) * 255
        plates['y'] = (stereogram_colors == 2).astype(np.uint8) * 255
        if p.stereo_num_colors == 4:
            plates['k'] = (stereogram_colors == 3).astype(np.uint8) * 255
        if p.stereo_fray_x_edge > 0:
            for ch in plates:
                plates[ch] = self._apply_fray_x_edge(plates[ch], p.stereo_fray_x_edge)
        if p.stereo_fray_y_edge > 0:
            for ch in plates:
                plates[ch] = self._apply_fray_y_edge(plates[ch], p.stereo_fray_y_edge)
        return plates

    def compose_stereogram_rgb(self, plates: Dict[str, np.ndarray], p: Params) -> Image.Image:
        h, w = plates['c'].shape
        rgb_array = np.ones((h, w, 3), dtype=np.uint8) * 255
        def hex_to_rgb(hex_str: str) -> Tuple[int, int, int]:
            hex_str = hex_str.lstrip('#')
            r, g, b = (int(hex_str[i:i+2], 16) for i in (0, 2, 4))
            return (r, g, b)
        c_mask = plates['c'] > 0
        m_mask = plates['m'] > 0
        y_mask = plates['y'] > 0
        rgb_array[c_mask] = hex_to_rgb(p.stereo_color_c)
        rgb_array[m_mask] = hex_to_rgb(p.stereo_color_m)
        rgb_array[y_mask] = hex_to_rgb(p.stereo_color_y)
        if p.stereo_num_colors == 4 and 'k' in plates:
            k_mask = plates['k'] > 0
            rgb_array[k_mask] = hex_to_rgb(p.stereo_color_k)
        return Image.fromarray(rgb_array).convert('RGBA')

    def render_stereogram(self, base_rgba: Image.Image, p: Params,
                          pattern_offset: int = 0) -> Image.Image:
        offset = p.stereo_pattern_offset if hasattr(p, 'stereo_pattern_offset') else pattern_offset
        # Capture alpha mask before processing to exclude transparent areas
        alpha = np.array(base_rgba.getchannel("A"), dtype=np.uint8)
        depth_map = self.process_depth_map(base_rgba, p)
        stereogram_colors = self.generate_stereogram_multicolor(depth_map, p,
                                                                 pattern_offset=offset)
        plates = self.separate_stereogram_to_plates(stereogram_colors, p)
        result = self.compose_stereogram_rgb(plates, p)
        # Apply original alpha: keep transparent areas transparent
        opaque_mask = alpha > 0
        result_arr = np.array(result)
        result_arr[~opaque_mask, :3] = 255  # White RGB where transparent
        result_arr[~opaque_mask, 3] = 0     # Preserve transparency
        # Blend partial alpha from original
        result_arr[opaque_mask, 3] = alpha[opaque_mask]
        return Image.fromarray(result_arr)

    def clear_caches(self):
        self._depth_cache.clear()
        self._pattern_strip_cache.clear()
        self._plates_cache.clear()


# ── Dedicated auto-save directory ──────────────────────────────────────
AUTOSAVE_DIR = os.path.join(os.path.expanduser("~"), ".halftone_glitch")

def _autosave_path() -> str:
    """Return the path for the dedicated auto-save file."""
    os.makedirs(AUTOSAVE_DIR, exist_ok=True)
    return os.path.join(AUTOSAVE_DIR, "autosave.htg")


class NewDocumentDialog(QWidget):
    """Startup dialog for setting document size, orientation, and DPI."""

    accepted = Signal(dict)   # emits settings dict when user clicks Create
    cancelled = Signal()      # emits if user closes without creating

    PRESETS = {
        "11 × 14 in": (11.0, 14.0),
        "11 × 15 in": (11.0, 15.0),
        "9 × 12 in":  (9.0, 12.0),
        "5 × 7 in (card)": (5.0, 7.0),
        "13 × 19 in": (13.0, 19.0),
        "15 × 22 in": (15.0, 22.0),
        "8.5 × 11 in": (8.5, 11.0),
        "18 × 24 in": (18.0, 24.0),
        "24 × 36 in": (24.0, 36.0),
        "custom":     None,
    }

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("new document")
        self.setFixedSize(420, 380)
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.WindowStaysOnTopHint)
        ic = _load_app_icon()
        if ic:
            self.setWindowIcon(ic)

        layout = QVBoxLayout(self)
        layout.setSpacing(14)
        layout.setContentsMargins(28, 24, 28, 20)

        # Title
        title = QLabel("new document")
        title.setStyleSheet("font-size:16pt; font-weight:bold; color:#fff;")
        layout.addWidget(title)

        # --- Preset ---
        preset_row = QHBoxLayout()
        preset_row.addWidget(QLabel("preset"))
        self.preset_combo = QComboBox()
        for name in self.PRESETS:
            self.preset_combo.addItem(name)
        self.preset_combo.setCurrentText("11 × 14 in")
        self.preset_combo.currentTextChanged.connect(self._on_preset_changed)
        preset_row.addWidget(self.preset_combo, 1)
        layout.addLayout(preset_row)

        # --- Custom size ---
        size_row = QHBoxLayout()
        size_row.addWidget(QLabel("width"))
        self.width_input = QLineEdit("11")
        self.width_input.setFixedWidth(60)
        self.width_input.setAlignment(Qt.AlignmentFlag.AlignCenter)
        size_row.addWidget(self.width_input)
        size_row.addWidget(QLabel("in"))
        size_row.addSpacing(16)
        size_row.addWidget(QLabel("height"))
        self.height_input = QLineEdit("14")
        self.height_input.setFixedWidth(60)
        self.height_input.setAlignment(Qt.AlignmentFlag.AlignCenter)
        size_row.addWidget(self.height_input)
        size_row.addWidget(QLabel("in"))
        size_row.addStretch(1)
        layout.addLayout(size_row)
        # Start with custom inputs disabled (preset selected)
        self.width_input.setEnabled(False)
        self.height_input.setEnabled(False)

        # --- Orientation ---
        orient_row = QHBoxLayout()
        orient_row.addWidget(QLabel("orientation"))
        self.portrait_btn = QPushButton("portrait")
        self.landscape_btn = QPushButton("landscape")
        self.portrait_btn.setCheckable(True)
        self.landscape_btn.setCheckable(True)
        self.portrait_btn.setChecked(True)
        self.portrait_btn.clicked.connect(lambda: self._set_orientation("portrait"))
        self.landscape_btn.clicked.connect(lambda: self._set_orientation("landscape"))
        self._update_orient_style()
        orient_row.addWidget(self.portrait_btn)
        orient_row.addWidget(self.landscape_btn)
        orient_row.addStretch(1)
        layout.addLayout(orient_row)

        # --- DPI ---
        dpi_row = QHBoxLayout()
        dpi_row.addWidget(QLabel("dpi"))
        self.dpi_slider = QSlider(Qt.Orientation.Horizontal)
        self.dpi_slider.setRange(72, 240)
        self.dpi_slider.setValue(120)
        self.dpi_label = QLabel("120")
        self.dpi_slider.valueChanged.connect(lambda v: self.dpi_label.setText(str(v)))
        dpi_row.addWidget(self.dpi_slider, 1)
        dpi_row.addWidget(self.dpi_label)
        layout.addLayout(dpi_row)

        # --- Info ---
        self.info_label = QLabel()
        self.info_label.setStyleSheet("color:#aaa; font-size:9pt;")
        layout.addWidget(self.info_label)
        self._update_info()
        self.width_input.textChanged.connect(lambda _: self._update_info())
        self.height_input.textChanged.connect(lambda _: self._update_info())
        self.dpi_slider.valueChanged.connect(lambda _: self._update_info())
        self.portrait_btn.clicked.connect(lambda: self._update_info())
        self.landscape_btn.clicked.connect(lambda: self._update_info())

        layout.addStretch(1)

        # --- Buttons ---
        btn_row = QHBoxLayout()
        self.resume_btn = QPushButton("resume last session")
        self.resume_btn.setEnabled(os.path.isfile(_autosave_path()))
        self.resume_btn.clicked.connect(self._on_resume)
        self.create_btn = QPushButton("create")
        self.create_btn.setStyleSheet("background:#e87a1e; color:#fff; font-weight:bold; padding:8px 24px; border-radius:6px;")
        self.create_btn.clicked.connect(self._on_create)
        btn_row.addWidget(self.resume_btn)
        btn_row.addStretch(1)
        btn_row.addWidget(self.create_btn)
        layout.addLayout(btn_row)

    # ── helpers ──

    def _on_preset_changed(self, text: str):
        preset = self.PRESETS.get(text)
        is_custom = (preset is None)
        self.width_input.setEnabled(is_custom)
        self.height_input.setEnabled(is_custom)
        self.portrait_btn.setEnabled(not is_custom)
        self.landscape_btn.setEnabled(not is_custom)
        if preset is not None:
            w, h = preset
            self.width_input.setText(str(w))
            self.height_input.setText(str(h))
        self._update_orient_style()
        self._update_info()

    def _set_orientation(self, orient: str):
        self.portrait_btn.setChecked(orient == "portrait")
        self.landscape_btn.setChecked(orient == "landscape")
        self._update_orient_style()

    def _update_orient_style(self):
        on = "background:#e87a1e; color:#fff; border:1px solid #e87a1e;"
        off = ""
        disabled = "background:#555; color:#888; border:1px solid #555;"
        if not self.portrait_btn.isEnabled():
            self.portrait_btn.setStyleSheet(disabled)
            self.landscape_btn.setStyleSheet(disabled)
        else:
            self.portrait_btn.setStyleSheet(on if self.portrait_btn.isChecked() else off)
            self.landscape_btn.setStyleSheet(on if self.landscape_btn.isChecked() else off)

    def _get_size_in(self) -> Tuple[float, float]:
        try:
            w = float(self.width_input.text())
        except ValueError:
            w = 11.0
        try:
            h = float(self.height_input.text())
        except ValueError:
            h = 14.0
        w = max(1.0, min(60.0, w))
        h = max(1.0, min(60.0, h))
        return (w, h)

    def _update_info(self):
        w, h = self._get_size_in()
        is_custom = (self.PRESETS.get(self.preset_combo.currentText()) is None)
        if not is_custom:
            orient = "portrait" if self.portrait_btn.isChecked() else "landscape"
            if orient == "landscape":
                w, h = h, w
        dpi = self.dpi_slider.value()
        px_w, px_h = int(round(w * dpi)), int(round(h * dpi))
        self.info_label.setText(f"{px_w} × {px_h} px  •  {w} × {h} in  •  {dpi} dpi")

    def _on_create(self):
        w, h = self._get_size_in()
        is_custom = (self.PRESETS.get(self.preset_combo.currentText()) is None)
        if is_custom:
            # User typed final dimensions directly — normalize to portrait convention
            if w > h:
                w, h, orient = h, w, "landscape"
            else:
                orient = "portrait"
        else:
            orient = "portrait" if self.portrait_btn.isChecked() else "landscape"
        self.accepted.emit({
            'width_in': w,
            'height_in': h,
            'orientation': orient,
            'dpi': self.dpi_slider.value(),
            'resume': False,
        })
        self.close()

    def _on_resume(self):
        self.accepted.emit({'resume': True})
        self.close()

    def closeEvent(self, event):
        self.cancelled.emit()
        super().closeEvent(event)


class Main(QMainWindow):
    def __init__(self, doc_settings: Optional[dict] = None):
        super().__init__()

        # --- DOCUMENT SETTINGS (from startup dialog) ---
        self._doc_width_in: float = 11.0
        self._doc_height_in: float = 14.0
        self._doc_orientation: str = "portrait"
        self._doc_dpi: int = 120
        if doc_settings and not doc_settings.get('resume'):
            self._doc_width_in = doc_settings.get('width_in', 11.0)
            self._doc_height_in = doc_settings.get('height_in', 14.0)
            self._doc_orientation = doc_settings.get('orientation', 'portrait')
            self._doc_dpi = doc_settings.get('dpi', 120)

        self.ART_SIZES = {"11×14 in": (11.0, 14.0), "11×15 in": (11.0, 15.0), "9×12 in": (9.0, 12.0), "13×19 in": (13.0, 19.0), "15×22 in": (15.0, 22.0)}
        self.setWindowTitle("halftone_glitch_v2")
        self.setMinimumSize(1300, 900)

        ic = _load_app_icon()
        if ic:
            self.setWindowIcon(ic)

        self.cmyk_icc_path: Optional[str] = find_cmyk_icc()
        self.img_full_rgba: Optional[Image.Image] = None

        self._prev_pix: Optional[QPixmap] = None
        self.prev_lbl: Optional[PreviewArea] = None

        self.shape_paths: Optional[List["SVGPath"]] = None  # type: ignore
        self.shape_bbox: Optional[Tuple[float, float, float, float]] = None
        self.rotate_shape = True

        self._sprite_cache: Dict[str, Image.Image] = {}
        self._rotated_sprite_cache: Dict[Tuple[str, int, int], Image.Image] = {}
        self._mask_cache: Dict[Tuple[str, int, int, int], Image.Image] = {}
        self._art_cache: Dict[Tuple, Image.Image] = {}
        self._cmyk_cache: Dict[Tuple, Image.Image] = {}
        self._arr_cache: Dict[Tuple, np.ndarray] = {}
        self._grid_cache: Dict[Tuple[int, int, float, float], np.ndarray] = {}
        self._noise_cache: Dict[Tuple, np.ndarray] = {}

        self._last_render_base_rgba: Optional[Image.Image] = None
        self._halftone_dirty = True
        self._threads = max(2, min(16, (cpu_count() or 4)))
        self._pool = ThreadPoolExecutor(max_workers=self._threads)
        # Advanced performance monitoring and caching
        self._perf_cache = {}
        self._preview_cache = {}  # Cache preview images
        self._last_params_hash = None  # Track parameter changes
        self.stereo_core = StereogramCore()
        self._render_timer = QTimer()
        self._render_timer.setSingleShot(True)
        self._render_timer.timeout.connect(self._delayed_render)
        self.interacting = False
        self._last_fast_preview = None
        
        # Interactive slider timer for throttled updates
        self._interact_timer = QTimer()
        self._interact_timer.setSingleShot(True)
        self._interact_timer.timeout.connect(lambda: self.update_preview(force=False))
        
        # Debounced moire tile timer — avoids redundant 4-plate renders on every slider tick
        self._moire_timer = QTimer()
        self._moire_timer.setSingleShot(True)
        self._moire_timer.timeout.connect(self._update_moire_tile)
        
        # Content alpha cache to avoid recomposing artboard every frame
        self._content_alpha_cache_key = None
        self._content_alpha_cache_img = None
        
        # Pre-allocated composite buffer
        self._composite_buf_shape = (0, 0)
        self._composite_buf = None
        self._composite_rgba = None
        
        # Background processing for non-critical operations
        self._background_timer = QTimer()
        self._background_timer.timeout.connect(self._background_cleanup)
        self._background_timer.start(5000)  # Clean cache every 5 seconds
        
        # Show performance optimizations status
        self._show_performance_status()

        self.preview_timer = QTimer(self)
        self.preview_timer.setSingleShot(True)
        self.preview_timer.timeout.connect(lambda: self.update_preview(force=False))

        self._offset_x = 0
        self._offset_y = 0

        # --- ARTBOARD BACKGROUND ---
        self._bg_black = False  # False = white, True = black

        # --- LAYER SYSTEM ---
        self._layers: List[Layer] = []
        self._selected_layer_idx: int = -1
        self._restoring_params = False  # Flag to prevent cascading UI updates during param restore
        self._suppress_apply_preview = False  # Suppress update_preview inside _apply_params_to_ui
        self._layer_render_cache: Dict[int, Image.Image] = {}  # Per-layer rendered image cache
        self._layer_render_cache_context = None  # Track global context for per-layer cache validity
        self._layer_list_dirty = False  # Debounce flag for layer list widget rebuild

        # --- UNDO SYSTEM ---
        self._undo_stack: deque = deque(maxlen=50)
        self._redo_stack: deque = deque(maxlen=50)
        self._undo_timer = QTimer()
        self._undo_timer.setSingleShot(True)
        self._undo_timer.setInterval(600)  # auto-snapshot 600ms after last change
        self._undo_timer.timeout.connect(self._auto_snapshot)
        self._last_snapshot_time = 0.0

        # --- PROJECT FILE ---
        self._project_path: Optional[str] = None
        self._working_dir: Optional[str] = None
        self._interact_cmyk_cache_key = None
        self._interact_cmyk_cache_img = None

        # --- TOP TOOLBAR ---
        file_btn = QPushButton("file ▾")
        file_menu = QMenu(file_btn)
        file_menu.addAction("open…", self.on_open)
        file_menu.addAction("save", self.on_save_project)
        file_menu.addAction("save as…", self.on_save_project_as)
        file_menu.addAction("load project…", self.on_load_project)
        file_menu.addAction("import assets…", self._on_add_asset)
        file_menu.addSeparator()
        file_menu.addAction("set working folder…", self._on_set_working_dir)
        file_btn.setMenu(file_menu)

        export_svg_btn = QPushButton(".svg"); export_svg_btn.clicked.connect(self.on_export_svg); export_svg_btn.setEnabled(False)
        export_png_btn = QPushButton(".png"); export_png_btn.clicked.connect(self.on_export_png); export_png_btn.setEnabled(False)
        export_pdf_btn = QPushButton(".pdf"); export_pdf_btn.clicked.connect(self.on_export_pdf); export_pdf_btn.setEnabled(False)
        export_tiff_btn = QPushButton(".tiff"); export_tiff_btn.clicked.connect(self.on_export_tiff_cmyk); export_tiff_btn.setEnabled(False)
        self.export_svg_btn = export_svg_btn; self.export_png_btn = export_png_btn
        self.export_pdf_btn = export_pdf_btn; self.export_tiff_btn = export_tiff_btn

        undo_btn = QPushButton("\u21a9 undo"); undo_btn.clicked.connect(self.on_undo)
        redo_btn = QPushButton("\u21aa redo"); redo_btn.clicked.connect(self.on_redo)
        self._undo_btn = undo_btn; self._redo_btn = redo_btn
        toolbar = QHBoxLayout()
        for b in (file_btn, export_svg_btn, export_png_btn, export_pdf_btn, export_tiff_btn):
            toolbar.addWidget(b)
        toolbar.addStretch(1)
        toolbar.addWidget(undo_btn); toolbar.addWidget(redo_btn)

        # --- AUTO-SAVE TIMER (background, every 30s) ---
        self._autosave_timer = QTimer()
        self._autosave_timer.setInterval(30_000)
        self._autosave_timer.timeout.connect(self._auto_save_project)
        self._autosave_timer.start()

        # --- OVERVIEW GROUP ---
        header_group = QGroupBox("overview")
        header_l = QHBoxLayout()
        self.mode = QComboBox(); self.mode.addItems(["dot", "circle", "circle outline", "square", "diamond", "triangle", "cross", "lines"])
        self.mode.currentTextChanged.connect(lambda _t: (self._mark_halftone_dirty(), self._on_control_changed(), self._schedule_moire_update()))
        self.preview_chan = QComboBox(); self.preview_chan.addItems(["composite", "c", "m", "y", "k"])
        self.preview_chan.currentTextChanged.connect(self._on_preview_channel_changed)
        self.full_comp = QCheckBox("full composite"); self.full_comp.setChecked(False)
        self.full_comp.stateChanged.connect(self._on_full_composite_changed)
        self.full_comp.stateChanged.connect(lambda _v: (self._mark_halftone_dirty(), self._on_control_changed()))
        self.gray_chk = QCheckBox("B/W halftone (K only)"); self.gray_chk.setChecked(False)
        self.gray_chk.stateChanged.connect(self._on_gray_toggled)
        for w in (QLabel("mode"), self.mode, QLabel("preview"), self.preview_chan, self.full_comp, self.gray_chk):
            header_l.addWidget(w)

        # --- DPI (hidden, driven by startup dialog / project load) ---
        self.output_dpi_s = QSlider(Qt.Orientation.Horizontal); self.output_dpi_s.setRange(72, 240)
        self.output_dpi_s.setValue(self._doc_dpi); self.output_dpi_s.setVisible(False)
        self.output_dpi_lbl = QLabel(str(self._doc_dpi)); self.output_dpi_lbl.setVisible(False)
        self.output_dpi_s.valueChanged.connect(lambda v: (self.output_dpi_lbl.setText(str(v)),
            self._on_artboard_changed()))

        header_l.addStretch(1)
        header_group.setLayout(header_l)

        # --- ARTBOARD GROUP (compact — size/orient/dpi set at startup) ---
        w_in, h_in = self._doc_width_in, self._doc_height_in
        if self._doc_orientation == "landscape":
            w_in, h_in = h_in, w_in
        self.art_group = QGroupBox()
        self.art_group.setStyleSheet("QGroupBox{border:none; margin:0; padding:0;}")

        art = QVBoxLayout()
        art.setSpacing(4)
        art.setContentsMargins(4, 2, 4, 2)

        # Hidden widgets kept for compatibility with rest of codebase
        self.orientation = QComboBox()
        self.orientation.addItems(["portrait", "landscape"])
        self.orientation.setCurrentText(self._doc_orientation)
        self.orientation.setVisible(False)
        self.orientation.currentTextChanged.connect(self._on_artboard_changed)

        self.art_size = QComboBox()
        for name in self.ART_SIZES.keys():
            self.art_size.addItem(name)
        matched = False
        for name, (pw, ph) in self.ART_SIZES.items():
            if abs(pw - self._doc_width_in) < 0.01 and abs(ph - self._doc_height_in) < 0.01:
                self.art_size.setCurrentText(name)
                matched = True
                break
        if not matched:
            custom_label = f"{self._doc_width_in}×{self._doc_height_in} in"
            self.ART_SIZES[custom_label] = (self._doc_width_in, self._doc_height_in)
            self.art_size.addItem(custom_label)
            self.art_size.setCurrentText(custom_label)
        self.art_size.setVisible(False)
        self.art_size.currentTextChanged.connect(self._on_artboard_changed)

        # Single compact row: scale label, center, fit image, slider, input
        srow = QHBoxLayout()
        srow.addWidget(QLabel("scale"))

        self.center_btn = QPushButton("center")
        self.center_btn.clicked.connect(self.center_offsets)
        self.fit_image_btn = QPushButton("fit image")
        self.fit_image_btn.clicked.connect(self.fit_image_to_artboard)
        srow.addWidget(self.center_btn)
        srow.addWidget(self.fit_image_btn)

        self.scale_s = QSlider(Qt.Orientation.Horizontal)
        self.scale_s.setRange(10, 400)
        self.scale_s.setValue(100)
        self.scale_s.setFixedWidth(140)

        self.scale_input = QLineEdit("100")
        self.scale_input.setFixedWidth(40)
        self.scale_input.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.scale_pct_lbl = QLabel("%")

        self._scale_updating = False  # guard against recursion

        def _on_scale_slider(v):
            if self._scale_updating:
                return
            self._scale_updating = True
            self.scale_input.setText(str(v))
            self._scale_updating = False
            idx = self._selected_layer_idx
            if 0 <= idx < len(self._layers) and not self._layers[idx].locked:
                self._layers[idx].scale_pct = int(v)
                self._rebuild_composite()
                self._throttled_slider_update()

        def _on_scale_input_edited():
            if self._scale_updating:
                return
            txt = self.scale_input.text().strip().rstrip('%')
            try:
                v = int(txt)
                v = max(self.scale_s.minimum(), min(self.scale_s.maximum(), v))
                self._scale_updating = True
                self.scale_s.setValue(v)
                self._scale_updating = False
                idx = self._selected_layer_idx
                if 0 <= idx < len(self._layers) and not self._layers[idx].locked:
                    self._layers[idx].scale_pct = int(v)
                    self._rebuild_composite()
                    self._throttled_slider_update()
            except ValueError:
                pass

        self.scale_s.valueChanged.connect(_on_scale_slider)
        self.scale_s.sliderPressed.connect(self._on_slider_pressed)
        self.scale_s.sliderReleased.connect(self._on_slider_released)
        self.scale_input.editingFinished.connect(_on_scale_input_edited)

        srow.addWidget(self.scale_s)
        srow.addWidget(self.scale_input)
        srow.addWidget(self.scale_pct_lbl)
        srow.addSpacing(12)

        # zoom controls inline
        srow.addWidget(QLabel("zoom"))
        self.zoom_minus = QPushButton("–"); self.zoom_minus.setFixedWidth(24)
        self.zoom_plus  = QPushButton("+"); self.zoom_plus.setFixedWidth(24)
        self.zoom_fit   = QPushButton("fit")
        self.zoom_100   = QPushButton("100%")

        self.zoom = QSlider(Qt.Orientation.Horizontal)
        self.zoom.setRange(10, 400)
        self.zoom.setValue(100)

        srow.addWidget(self.zoom_minus)
        srow.addWidget(self.zoom, 1)
        srow.addWidget(self.zoom_plus)
        srow.addWidget(self.zoom_fit)
        srow.addWidget(self.zoom_100)
        art.addLayout(srow)
        def _zoom_apply():
            if self.prev_lbl:
                self.prev_lbl.set_zoom(self.zoom.value() / 100.0)
                self._update_scrollbar_ranges()

        self.zoom.valueChanged.connect(lambda _v: _zoom_apply())
        self.zoom_minus.clicked.connect(lambda: self.zoom.setValue(max(self.zoom.minimum(), self.zoom.value() - 10)))
        self.zoom_plus.clicked.connect(lambda: self.zoom.setValue(min(self.zoom.maximum(), self.zoom.value() + 10)))
        self.zoom_100.clicked.connect(lambda: self.zoom.setValue(100))
        self.zoom_fit.clicked.connect(self.fit_view_to_window)

        # attach layout + keep group compact so it sits neatly above preview
        from PySide6.QtWidgets import QSizePolicy
        self.art_group.setLayout(art)
        self.art_group.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum)

        # --- PRESETS FOR CMYK ---
        self.PRESETS = {
            "preset 1 (c15 m75 y0 k45)": (15, 75, 0, 45),
            "preset 2 (c105 m75 y90 k15)": (105, 75, 90, 15),
            "preset 3 (c15 m45 y0 k75)": (15, 45, 0, 75),
            "preset 4 (c165 m45 y90 k105)": (165, 45, 90, 105),
        }

        # --- GLITCH FX GROUP ---
        def row(label, minv, maxv, init, fmt, on_change_cb=None):
            h = QHBoxLayout()
            lab = QLabel(label); lab.setMinimumWidth(110); h.addWidget(lab)
            s = QSlider(Qt.Orientation.Horizontal); s.setRange(minv, maxv); s.setValue(init)
            # Auto-detect display→slider scale (e.g. fmt shows x/100 → inv=100)
            _ref = 100 if minv <= 100 <= maxv else max(abs(minv), 1)
            _probe = fmt(_ref)
            _nchars = ''.join(c for c in str(_probe) if c.isdigit() or c in '.-')
            try:
                _inv = float(_ref) / float(_nchars) if _nchars and float(_nchars) != 0 else 1.0
            except Exception:
                _inv = 1.0
            inp = QLineEdit(fmt(init))
            inp.setFixedWidth(64)
            inp.setAlignment(Qt.AlignmentFlag.AlignCenter)
            inp.setStyleSheet("QLineEdit { background:#2a2829; border:1px solid #555; border-radius:3px; padding:1px 3px; }")
            def on_change(x, _i=inp):
                _i.setText(fmt(x))
                if on_change_cb:
                    on_change_cb()
                else:
                    self._mark_halftone_dirty()
                    if self.interacting:
                        if hasattr(self, '_interact_timer'):
                            self._interact_timer.stop()
                            self._interact_timer.start(30)
                    else:
                        self._on_control_changed()
                        self._schedule_moire_update()
            def on_typed(_s=s, _inv=_inv, _mn=minv, _mx=maxv, _i=inp):
                text = _i.text().strip()
                num = ''.join(c for c in text if c.isdigit() or c in '.-')
                try:
                    raw = int(round(float(num) * _inv))
                    _s.setValue(max(_mn, min(_mx, raw)))
                except ValueError:
                    _i.setText(fmt(_s.value()))
            s.valueChanged.connect(on_change)
            s.sliderPressed.connect(self._on_slider_pressed)
            s.sliderReleased.connect(self._on_slider_released)
            s.setTracking(True)
            inp.editingFinished.connect(on_typed)
            h.addWidget(s, 1); h.addWidget(inp)
            return h, s, inp

        glitch_group = QGroupBox("glitch fx")
        
        # Create main layout with header row for invert checkbox
        glitch_main_layout = QVBoxLayout()
        glitch_main_layout.setContentsMargins(6, 6, 6, 6)
        
        # Header row with invert checkbox aligned to right
        glitch_header_row = QHBoxLayout()
        glitch_header_row.addStretch(1)  # Push checkbox to the right
        self.glitch_invert_chk = QCheckBox("invert")
        self.glitch_invert_chk.setChecked(False)
        self.glitch_invert_chk.stateChanged.connect(lambda _v: (self._mark_halftone_dirty(), self._on_control_changed()))
        glitch_header_row.addWidget(self.glitch_invert_chk)
        glitch_main_layout.addLayout(glitch_header_row)
        
        # Content layout for sliders
        glitch_layout = QVBoxLayout()
        glitch_layout.setContentsMargins(0, 0, 0, 0)
        
        slice_shift_row, self.slice_shift_s, self.slice_shift_lbl = row("slice shift", 0, 150, 0, lambda x: f"{x}px")
        slice_size_row, self.slice_size_s, self.slice_size_lbl = row("slice size", 2, 200, 20, lambda x: f"{x}px")
        slice_angle_row, self.slice_angle_s, self.slice_angle_lbl = row("slice angle", 0, 180, 0, lambda x: f"{x}\u00b0")
        vertical_slice_shift_row, self.vertical_slice_shift_s, self.vertical_slice_shift_lbl = row("vertical slice shift", 0, 150, 0, lambda x: f"{x}px")
        vertical_slice_size_row, self.vertical_slice_size_s, self.vertical_slice_size_lbl = row("v.slice size", 2, 200, 20, lambda x: f"{x}px")
        vertical_slice_angle_row, self.vertical_slice_angle_s, self.vertical_slice_angle_lbl = row("v.slice angle", 0, 180, 0, lambda x: f"{x}\u00b0")
        warp_row, self.warp_amt_s, self.warp_amt_lbl = row("grid warp", 0, 200, 0, lambda x: f"{x/10.0:.1f}px")
        warp_scale_row, self.warp_scale_s, self.warp_scale_lbl = row("warp scale", 10, 500, 100, lambda x: f"{x}%")
        glitch_layout.addLayout(slice_shift_row)
        glitch_layout.addLayout(slice_size_row)
        glitch_layout.addLayout(slice_angle_row)
        glitch_layout.addLayout(vertical_slice_shift_row)
        glitch_layout.addLayout(vertical_slice_size_row)
        glitch_layout.addLayout(vertical_slice_angle_row)
        glitch_layout.addLayout(warp_row)
        glitch_layout.addLayout(warp_scale_row)

        # ── Diffusion glitch effects ──
        diffusion_glitch_sep = QLabel("─── Diffusion Glitches ───")
        diffusion_glitch_sep.setStyleSheet("color: #888; font-size: 9pt;")
        diffusion_glitch_sep.setAlignment(Qt.AlignmentFlag.AlignCenter)
        glitch_layout.addWidget(diffusion_glitch_sep)

        broken_kernel_row, self.broken_kernel_s, self.broken_kernel_lbl = row("broken kernel", 0, 100, 0, lambda x: f"{x}%")
        dir_bias_row, self.dir_bias_s, self.dir_bias_lbl = row("directional bias", 0, 100, 0, lambda x: f"{x}%")
        dir_bias_angle_row, self.dir_bias_angle_s, self.dir_bias_angle_lbl = row("bias angle", 0, 360, 0, lambda x: f"{x}°")
        error_overflow_row, self.error_overflow_s, self.error_overflow_lbl = row("error overflow", 0, 100, 0, lambda x: f"{x}%")
        diffusion_reset_row, self.diffusion_reset_s, self.diffusion_reset_lbl = row("diffusion reset", 0, 100, 0, lambda x: f"{x}%")
        cross_bleed_row, self.cross_bleed_s, self.cross_bleed_lbl = row("cross-channel bleed", 0, 100, 0, lambda x: f"{x}%")
        glitch_layout.addLayout(broken_kernel_row)
        glitch_layout.addLayout(dir_bias_row)
        glitch_layout.addLayout(dir_bias_angle_row)
        glitch_layout.addLayout(error_overflow_row)
        glitch_layout.addLayout(diffusion_reset_row)
        glitch_layout.addLayout(cross_bleed_row)

        # ── Datamosh effects ──
        datamosh_sep = QLabel("─── Datamosh ───")
        datamosh_sep.setStyleSheet("color: #888; font-size: 9pt;")
        datamosh_sep.setAlignment(Qt.AlignmentFlag.AlignCenter)
        glitch_layout.addWidget(datamosh_sep)

        smear_drag_row, self.smear_drag_s, self.smear_drag_lbl = row("smear drag", 0, 100, 0, lambda x: f"{x}%")
        smear_length_row, self.smear_length_s, self.smear_length_lbl = row("smear length", 4, 120, 24, lambda x: f"{x}px")
        macroblock_row, self.macroblock_s, self.macroblock_lbl = row("macroblock corrupt", 0, 100, 0, lambda x: f"{x}%")
        macroblock_dropout_row, self.macroblock_dropout_s, self.macroblock_dropout_lbl = row("dropout mix", 0, 100, 25, lambda x: f"{x}%")
        block_shift_row, self.block_shift_s, self.block_shift_lbl = row("block shift", 0, 100, 0, lambda x: f"{x}%")
        block_size_row, self.block_size_s, self.block_size_lbl = row("block size", 4, 64, 16, lambda x: f"{x}px")
        chan_desync_row, self.chan_desync_s, self.chan_desync_lbl = row("channel desync", 0, 100, 0, lambda x: f"{x}%")
        bitmap_sort_row, self.bitmap_sort_s, self.bitmap_sort_lbl = row("bitmap sort", 0, 100, 0, lambda x: f"{x}%")

        self.smear_vertical_chk = QCheckBox("vertical")
        self.smear_vertical_chk.setChecked(False)
        self.smear_vertical_chk.stateChanged.connect(lambda _: (self._mark_halftone_dirty(), self._on_control_changed()))

        self.bitmap_sort_vert_chk = QCheckBox("vertical")
        self.bitmap_sort_vert_chk.setChecked(False)
        self.bitmap_sort_vert_chk.stateChanged.connect(lambda _: (self._mark_halftone_dirty(), self._on_control_changed()))

        smear_opts = QHBoxLayout()
        smear_opts.addLayout(smear_drag_row)
        smear_opts.addWidget(self.smear_vertical_chk)

        bitmap_sort_opts = QHBoxLayout()
        bitmap_sort_opts.addLayout(bitmap_sort_row)
        bitmap_sort_opts.addWidget(self.bitmap_sort_vert_chk)

        glitch_layout.addLayout(smear_opts)
        glitch_layout.addLayout(smear_length_row)
        glitch_layout.addLayout(macroblock_row)
        glitch_layout.addLayout(macroblock_dropout_row)
        glitch_layout.addLayout(block_shift_row)
        glitch_layout.addLayout(block_size_row)
        glitch_layout.addLayout(chan_desync_row)
        glitch_layout.addLayout(bitmap_sort_opts)

        glitch_main_layout.addLayout(glitch_layout)
        glitch_group.setLayout(glitch_main_layout)
        
        # --- LINES GROUP ---
        line_controls_page = QWidget()
        line_controls_layout = QVBoxLayout(line_controls_page)
        line_controls_layout.setContentsMargins(8, 6, 8, 8)
        line_controls_layout.setSpacing(6)
        
        # Header row with invert checkbox
        lines_header_row = QHBoxLayout()
        lines_header_row.addStretch(1)  # Push checkbox to the right
        self.lines_invert_chk = QCheckBox("invert")
        self.lines_invert_chk.setChecked(False)
        self.lines_invert_chk.stateChanged.connect(lambda _: (self._mark_halftone_dirty(), self.update_preview(force=True)))
        lines_header_row.addWidget(self.lines_invert_chk)
        line_controls_layout.addLayout(lines_header_row)
        
        # Initialize magnifying glass state
        self.magnifying_glass_active = False
        self.magnify_region = None  # (x, y, size) in artboard coordinates

        # Line length control
        line_length_row, self.line_length_s, self.line_length_lbl = row("line length", 10, 200, 100, lambda x: f"{x}%")
        line_controls_layout.addLayout(line_length_row)

        # Line width control  
        line_width_row, self.line_width_s, self.line_width_lbl = row("line width", 25, 1000, 100, lambda x: f"{x/100:.2f}px")
        line_controls_layout.addLayout(line_width_row)

        # Weight variation (for line width variation)
        line_weight_row, self.line_weight_s, self.line_weight_lbl = row("weight variation", 0, 100, 25, lambda x: f"{x}%")
        line_controls_layout.addLayout(line_weight_row)

        # Line density control (-100 to 200, default 100)
        line_density_row, self.line_density_s, self.line_density_lbl = row("line density", -100, 200, 100, lambda x: f"{x}%")
        line_controls_layout.addLayout(line_density_row)

        # Line taper (for natural ends)
        line_taper_row, self.line_taper_s, self.line_taper_lbl = row("line taper", 0, 100, 15, lambda x: f"{x}%")
        line_controls_layout.addLayout(line_taper_row)
        
        # Stroke randomness for organic feel
        stroke_random_row, self.stroke_random_s, self.stroke_random_lbl = row("stroke randomness", 0, 100, 10, lambda x: f"{x}%")
        line_controls_layout.addLayout(stroke_random_row)
        
        # --- Flow Path Controls ---
        flow_path_separator = QLabel("─── Flow Path ───")
        flow_path_separator.setStyleSheet("color: #888; font-size: 9pt;")
        flow_path_separator.setAlignment(Qt.AlignmentFlag.AlignCenter)
        line_controls_layout.addWidget(flow_path_separator)
        
        # Enable flow path checkbox
        self.lines_use_flow_path_chk = QCheckBox("use flow path direction")
        self.lines_use_flow_path_chk.setChecked(False)
        self.lines_use_flow_path_chk.stateChanged.connect(self._on_flow_path_toggle)
        line_controls_layout.addWidget(self.lines_use_flow_path_chk)
        
        # Draw/Clear path buttons row
        flow_path_btn_row = QHBoxLayout()
        
        self.draw_flow_path_btn = QPushButton("Draw Path")
        self.draw_flow_path_btn.setCheckable(True)
        self.draw_flow_path_btn.setChecked(False)
        self.draw_flow_path_btn.clicked.connect(self._on_draw_flow_path_clicked)
        flow_path_btn_row.addWidget(self.draw_flow_path_btn)
        
        self.clear_flow_path_btn = QPushButton("Clear Path")
        self.clear_flow_path_btn.clicked.connect(self._on_clear_flow_path_clicked)
        flow_path_btn_row.addWidget(self.clear_flow_path_btn)
        
        line_controls_layout.addLayout(flow_path_btn_row)
        
        # Show path checkbox
        self.show_flow_path_chk = QCheckBox("show path overlay")
        self.show_flow_path_chk.setChecked(True)
        self.show_flow_path_chk.stateChanged.connect(self._on_show_flow_path_changed)
        line_controls_layout.addWidget(self.show_flow_path_chk)
        
        # Path influence slider
        flow_influence_row, self.lines_path_influence_s, self.lines_path_influence_lbl = row("path influence", 0, 100, 100, lambda x: f"{x}%")
        line_controls_layout.addLayout(flow_influence_row)
        
        # Initialize flow path storage
        self._lines_flow_path: List[Tuple[float, float]] = []

        # Reset button for lines controls
        self.reset_line_btn = QPushButton("reset")
        self.reset_line_btn.setObjectName("ResetButton")
        self.reset_line_btn.clicked.connect(self._reset_lines_params)
        line_controls_layout.addWidget(self.reset_line_btn)
        
        # --- Diffusion Group ---
        diffusion_group = QGroupBox("diffusion")
        
        # Create main layout with header row for invert checkbox
        diffusion_main_layout = QVBoxLayout()
        diffusion_main_layout.setContentsMargins(6, 6, 6, 6)
        
        # Header row with invert checkbox aligned to right
        diffusion_header_row = QHBoxLayout()
        diffusion_header_row.addStretch(1)  # Push checkbox to the right
        self.diffusion_invert_chk = QCheckBox("invert")
        self.diffusion_invert_chk.setChecked(False)
        self.diffusion_invert_chk.stateChanged.connect(lambda _v: (self._mark_halftone_dirty(), self._on_control_changed()))
        diffusion_header_row.addWidget(self.diffusion_invert_chk)
        diffusion_main_layout.addLayout(diffusion_header_row)
        
        # Content layout for diffusion controls
        diffusion_layout = QVBoxLayout()
        diffusion_layout.setContentsMargins(0, 0, 0, 0)
        
        # Enable diffusion checkbox — disables halftone panel when active
        self.diffusion_enabled_chk = QCheckBox("enable diffusion")
        self.diffusion_enabled_chk.setChecked(False)
        self.diffusion_enabled_chk.stateChanged.connect(self._on_diffusion_toggled)
        diffusion_layout.addWidget(self.diffusion_enabled_chk)
        
        # Diffusion algorithm dropdown
        algo_row = QHBoxLayout()
        algo_row.addWidget(QLabel("algorithm"))
        self.diffusion_algo_combo = QComboBox()
        self.diffusion_algo_combo.addItems(["none", "floyd-steinberg", "jarvis-judice-ninke", "stucki", "burkes", "atkinson"])
        self.diffusion_algo_combo.currentTextChanged.connect(lambda _: (self._mark_halftone_dirty(), self._on_control_changed()))
        algo_row.addWidget(self.diffusion_algo_combo)
        diffusion_layout.addLayout(algo_row)

        # Modulation algorithm dropdown (sub-category of diffusion)
        mod_row = QHBoxLayout()
        mod_row.addWidget(QLabel("modulation"))
        self.diffusion_mod_combo = QComboBox()
        self.diffusion_mod_combo.addItems(["none", "column", "row", "dispersed", "medium", "heavy", "circuit", "tilt", "grid"])
        self.diffusion_mod_combo.currentTextChanged.connect(lambda _: (self._mark_halftone_dirty(), self._on_control_changed()))
        mod_row.addWidget(self.diffusion_mod_combo)
        diffusion_layout.addLayout(mod_row)

        # Modulation strength slider
        mod_str_row, self.diffusion_mod_strength_s, self.diffusion_mod_strength_lbl = row("mod strength", 0, 100, 50, lambda x: f"{x}%")
        diffusion_layout.addLayout(mod_str_row)

        # Diffusion intensity slider
        intensity_row, self.diffusion_intensity_s, self.diffusion_intensity_lbl = row("intensity", 0, 100, 50, lambda x: f"{x}%")
        diffusion_layout.addLayout(intensity_row)
        
        # Levels slider (quantization depth)
        levels_row, self.diffusion_levels_s, self.diffusion_levels_lbl = row("levels", 2, 32, 8, lambda x: f"{x}")
        diffusion_layout.addLayout(levels_row)
        
        # Sharpen strength slider
        sharpen_row, self.diffusion_sharpen_s, self.diffusion_sharpen_lbl = row("sharpen strength", 0, 100, 0, lambda x: f"{x}%")
        diffusion_layout.addLayout(sharpen_row)
        
        # Sharpen radius slider
        radius_row, self.diffusion_radius_s, self.diffusion_radius_lbl = row("sharpen radius", 1, 10, 1, lambda x: f"{x}px")
        diffusion_layout.addLayout(radius_row)
        
        # Denoise-to-noise slider (bipolar: negative = denoise, positive = add noise)
        denoise_row, self.diffusion_denoise_s, self.diffusion_denoise_lbl = row("denoise \u2194 noise", -100, 100, 0, lambda x: f"{x}%")
        diffusion_layout.addLayout(denoise_row)
        
        # Reset button for diffusion section
        self.reset_diffusion_btn = QPushButton("reset")
        self.reset_diffusion_btn.setObjectName("ResetButton")
        self.reset_diffusion_btn.clicked.connect(self._reset_diffusion_params)
        diffusion_layout.addWidget(self.reset_diffusion_btn)
        
        diffusion_main_layout.addLayout(diffusion_layout)
        diffusion_group.setLayout(diffusion_main_layout)

        # --- Channel displacement sliders ---
        disp_group = QGroupBox("channel displacement (px)")
        disp_grid = QGridLayout(); disp_grid.setContentsMargins(4, 8, 4, 4)
        disp_grid.addWidget(QLabel("ch"), 0, 0, Qt.AlignmentFlag.AlignCenter)
        disp_grid.addWidget(QLabel("x"),  0, 1, Qt.AlignmentFlag.AlignCenter)
        disp_grid.addWidget(QLabel("val"),0, 2, Qt.AlignmentFlag.AlignCenter)
        disp_grid.addWidget(QLabel("y"),  0, 3, Qt.AlignmentFlag.AlignCenter)
        disp_grid.addWidget(QLabel("val"),0, 4, Qt.AlignmentFlag.AlignCenter)

        self.disp_sliders = {}
        def _mk_disp_slider(init=0):
            s = QSlider(Qt.Orientation.Horizontal); s.setRange(-100, 100); s.setValue(init)
            inp = QLineEdit(f"{init}px"); inp.setFixedWidth(52); inp.setAlignment(Qt.AlignmentFlag.AlignCenter)
            inp.setStyleSheet("QLineEdit { background:#2a2829; border:1px solid #555; border-radius:3px; padding:1px 3px; }")
            def on_change(x, _i=inp):
                _i.setText(f"{x}px")
                self._mark_halftone_dirty()
                if self.interacting:
                    if hasattr(self, '_interact_timer'):
                        self._interact_timer.stop()
                        self._interact_timer.start(30)
                else:
                    self._on_control_changed()
            def on_typed(_s=s, _i=inp):
                text = _i.text().strip()
                num = ''.join(c for c in text if c.isdigit() or c in '.-')
                try:
                    raw = int(round(float(num)))
                    _s.setValue(max(-100, min(100, raw)))
                except ValueError:
                    _i.setText(f"{_s.value()}px")
            s.valueChanged.connect(on_change)
            s.sliderPressed.connect(self._on_slider_pressed)
            s.sliderReleased.connect(self._on_slider_released)
            inp.editingFinished.connect(on_typed)
            return s, inp

        for i, ch in enumerate("CMYK"):
            disp_grid.addWidget(QLabel(ch), i+1, 0, Qt.AlignmentFlag.AlignCenter)
            x_slider, x_lbl = _mk_disp_slider(0)
            y_slider, y_lbl = _mk_disp_slider(0)
            disp_grid.addWidget(x_slider, i+1, 1)
            disp_grid.addWidget(x_lbl,    i+1, 2)
            disp_grid.addWidget(y_slider, i+1, 3)
            disp_grid.addWidget(y_lbl,    i+1, 4)
            self.disp_sliders[ch.lower()] = (x_slider, y_slider)

        disp_group.setLayout(disp_grid)
        glitch_layout.addWidget(disp_group)

        # ── Stereogram ──
        stereo_sep_label = QLabel("─── Stereogram ───")
        stereo_sep_label.setStyleSheet("color: #888; font-size: 9pt;")
        stereo_sep_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        glitch_layout.addWidget(stereo_sep_label)

        self.stereo_mode_chk = QCheckBox("enable stereogram mode")
        self.stereo_mode_chk.setChecked(False)
        self.stereo_mode_chk.stateChanged.connect(self._on_stereo_mode_changed)
        glitch_layout.addWidget(self.stereo_mode_chk)

        stereo_depth_row, self.stereo_depth_s, _ = row("depth intensity", 0, 200, 50, lambda x: f"{x}%")
        stereo_sep_row, self.stereo_sep_s, _ = row("eye separation", 20, 120, 60, lambda x: f"{x}px")
        stereo_smooth_row, self.stereo_smooth_s, _ = row("depth smooth", 0, 100, 30, lambda x: f"{x}%")
        stereo_dot_row, self.stereo_dot_s, _ = row("dot size", 1, 20, 4, lambda x: f"{x}px")
        stereo_fray_x_row, self.stereo_fray_x_s, _ = row("fray x edge", 0, 100, 0, lambda x: f"{x}px")
        stereo_fray_y_row, self.stereo_fray_y_s, _ = row("fray y edge", 0, 100, 0, lambda x: f"{x}px")
        stereo_offset_row, self.stereo_offset_s, _ = row("pattern offset", 0, 200, 0, lambda x: f"{x}px")
        glitch_layout.addLayout(stereo_depth_row)
        glitch_layout.addLayout(stereo_sep_row)
        glitch_layout.addLayout(stereo_smooth_row)
        glitch_layout.addLayout(stereo_dot_row)
        glitch_layout.addLayout(stereo_fray_x_row)
        glitch_layout.addLayout(stereo_fray_y_row)
        glitch_layout.addLayout(stereo_offset_row)

        self.stereo_invert_chk = QCheckBox("invert depth")
        self.stereo_invert_chk.stateChanged.connect(self._on_stereo_control_changed)
        glitch_layout.addWidget(self.stereo_invert_chk)

        stereo_pattern_row = QHBoxLayout()
        stereo_pattern_row.addWidget(QLabel("pattern"))
        self.stereo_pattern_combo = QComboBox()
        self.stereo_pattern_combo.addItems(["random dots", "horizontal lines", "vertical lines",
                                             "diagonal /", "diagonal \\", "checkerboard", "grid"])
        self.stereo_pattern_combo.currentTextChanged.connect(self._on_stereo_control_changed)
        stereo_pattern_row.addWidget(self.stereo_pattern_combo)
        stereo_pattern_row.addWidget(QLabel("colors"))
        self.stereo_colors_combo = QComboBox()
        self.stereo_colors_combo.addItems(["3-color (CMY)", "4-color (CMYK)"])
        self.stereo_colors_combo.currentTextChanged.connect(self._on_stereo_control_changed)
        stereo_pattern_row.addWidget(self.stereo_colors_combo)
        glitch_layout.addLayout(stereo_pattern_row)

        self.stereo_color_c_hex = "#00FFFF"
        self.stereo_color_m_hex = "#FF00FF"
        self.stereo_color_y_hex = "#FFFF00"
        self.stereo_color_k_hex = "#000000"

        stereo_color_row = QHBoxLayout()
        self.btn_stereo_c = QPushButton("C"); self.btn_stereo_c.setFixedWidth(40)
        self.btn_stereo_c.setStyleSheet("background-color: cyan;")
        self.btn_stereo_c.clicked.connect(lambda: self._pick_stereo_color('c'))
        self.btn_stereo_m = QPushButton("M"); self.btn_stereo_m.setFixedWidth(40)
        self.btn_stereo_m.setStyleSheet("background-color: magenta;")
        self.btn_stereo_m.clicked.connect(lambda: self._pick_stereo_color('m'))
        self.btn_stereo_y = QPushButton("Y"); self.btn_stereo_y.setFixedWidth(40)
        self.btn_stereo_y.setStyleSheet("background-color: yellow;")
        self.btn_stereo_y.clicked.connect(lambda: self._pick_stereo_color('y'))
        self.btn_stereo_k = QPushButton("K"); self.btn_stereo_k.setFixedWidth(40)
        self.btn_stereo_k.setStyleSheet("background-color: black; color: white;")
        self.btn_stereo_k.clicked.connect(lambda: self._pick_stereo_color('k'))
        stereo_color_row.addWidget(QLabel("colors:"))
        stereo_color_row.addWidget(self.btn_stereo_c)
        stereo_color_row.addWidget(self.btn_stereo_m)
        stereo_color_row.addWidget(self.btn_stereo_y)
        stereo_color_row.addWidget(self.btn_stereo_k)
        stereo_color_row.addStretch()
        glitch_layout.addLayout(stereo_color_row)

        self.reset_glitch_btn = QPushButton("reset glitch fx")
        self.reset_glitch_btn.setObjectName("ResetButton")
        self.reset_glitch_btn.clicked.connect(self._reset_glitch_params)
        glitch_layout.addWidget(self.reset_glitch_btn)
        glitch_group.setLayout(glitch_layout)

        # compact row helper (HALFTONE ONLY) — keeps glitch rows untouched
        def row_ht(label, minv, maxv, init, fmt, on_change_cb=None):
            h = QHBoxLayout()
            h.setSpacing(4)
            h.setContentsMargins(0, 2, 0, 2)

            lab = QLabel(label)
            lab.setMinimumWidth(110)          # tighter than 150
            h.addWidget(lab)

            s = QSlider(Qt.Orientation.Horizontal)
            s.setRange(minv, maxv)
            s.setValue(init)

            v = QLabel(fmt(init))
            v.setFixedWidth(56)               # tighter than 80
            v.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

            def on_change(x, lab=v):
                lab.setText(fmt(x))
                if on_change_cb:
                    on_change_cb()
                else:
                    self._mark_halftone_dirty()
                    if self.interacting:
                        # Throttled update during drag for speed
                        if hasattr(self, '_interact_timer'):
                            self._interact_timer.stop()
                            self._interact_timer.start(30)  # 30ms throttle for smooth dragging
                    else:
                        self._on_control_changed()
                        self._schedule_moire_update()

            s.valueChanged.connect(on_change)
            s.sliderPressed.connect(self._on_slider_pressed)
            s.sliderReleased.connect(self._on_slider_released)
            # Add tracking for smoother real-time updates
            s.setTracking(True)  # Enable continuous updates while dragging

            h.addWidget(s, 1)
            h.addWidget(v)
            return h, s, v

        # --- HALFTONE GROUP (2×2, hard-packed) ---
        # Removed redundant inner imports that caused QHBoxLayout to be treated as a local (unbound earlier).

        class MiniRow(QWidget):
            """A compact row: Label | Slider | Value. Fixed height so it can’t expand."""
            def __init__(self, parent, label, minv, maxv, init, fmt):
                super().__init__(parent)
                self.setFixedHeight(32)  # <- increased height for better visibility

                h = QHBoxLayout(self)
                h.setContentsMargins(4, 2, 4, 2)  # Add some padding
                h.setSpacing(12)  # More spacing between elements

                lab = QLabel(label, self)
                lab.setMinimumWidth(100)  # Slightly wider label
                lab.setStyleSheet("font-weight: 500; color: #e6e6e6;")  # Better label styling

                s = QSlider(Qt.Orientation.Horizontal, self)
                s.setRange(minv, maxv); s.setValue(init)
                s.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
                s.setFixedHeight(20)  # <- bigger slider for easier interaction

                # Auto-detect display→slider scale factor
                _ref = 100 if minv <= 100 <= maxv else max(abs(minv), 1)
                _probe = fmt(_ref)
                _nchars = ''.join(c for c in str(_probe) if c.isdigit() or c in '.-')
                try:
                    _inv = float(_ref) / float(_nchars) if _nchars and float(_nchars) != 0 else 1.0
                except Exception:
                    _inv = 1.0
                val = QLineEdit(fmt(init), self)
                val.setFixedWidth(60)
                val.setAlignment(Qt.AlignmentFlag.AlignCenter)
                val.setStyleSheet("QLineEdit { background:#2a2829; border:1px solid #555; border-radius:3px; padding:1px 3px; font-weight:500; }")

                # Enhanced slider styling for better visibility
                s.setStyleSheet("""
                    QSlider::groove:horizontal { 
                        height: 4px; 
                        margin: 0; 
                        border: none; 
                        background: #555; 
                        border-radius: 2px;
                    }
                    QSlider::handle:horizontal { 
                        width: 16px; 
                        height: 16px; 
                        margin: -6px 0;
                        border: 2px solid #fff; 
                        background: #000; 
                        border-radius: 8px; 
                    }
                    QSlider::handle:horizontal:hover { 
                        background: #333; 
                    }
                """)

                h.addWidget(lab)
                h.addWidget(s, 1)
                h.addWidget(val)

                # expose controls
                self.slider = s
                self.value_label = val

                # wire update (slider → input)
                def _on(v, _val=val):
                    _val.setText(fmt(v))
                    parent._mark_halftone_dirty()
                    if parent.interacting:
                        if hasattr(parent, '_interact_timer'):
                            parent._interact_timer.stop()
                            parent._interact_timer.start(30)
                    else:
                        parent._on_control_changed()
                        parent._schedule_moire_update()
                # wire update (input → slider)
                def _on_typed(_s=s, _val=val, _inv=_inv, _mn=minv, _mx=maxv):
                    text = _val.text().strip()
                    num = ''.join(c for c in text if c.isdigit() or c in '.-')
                    try:
                        raw = int(round(float(num) * _inv))
                        _s.setValue(max(_mn, min(_mx, raw)))
                    except ValueError:
                        _val.setText(fmt(_s.value()))
                s.valueChanged.connect(_on)
                s.sliderPressed.connect(parent._on_slider_pressed)
                s.sliderReleased.connect(parent._on_slider_released)
                val.editingFinished.connect(_on_typed)

            # keep size hints tiny so layouts won’t grow it
            def sizeHint(self) -> QSize: return QSize(300, 32)
            def minimumSizeHint(self) -> QSize: return QSize(200, 32)

        # Build rows
        row_cell = MiniRow(self, "cell size",   25, 4000, 1600, lambda x: f"{x/100:.2f}px")
        row_str  = MiniRow(self, "stroke width", 25, 1000,  100,  lambda x: f"{x/100:.2f}px")
        row_ht_slice = MiniRow(self, "frayed x edge", 0, 100, 0, lambda x: f"{x}px")
        row_ht_vslice = MiniRow(self, "frayed y edge", 0, 100, 0, lambda x: f"{x}px")

        # keep your self.* references
        self.cell_s, self.cell_lbl = row_cell.slider, row_cell.value_label
        self.str_s,  self.str_lbl  = row_str.slider,  row_str.value_label
        self.ht_slice_s, self.ht_slice_lbl = row_ht_slice.slider, row_ht_slice.value_label
        self.ht_vslice_s, self.ht_vslice_lbl = row_ht_vslice.slider, row_ht_vslice.value_label

        # Group container
        halftone_group = QGroupBox("halftone")
        
        # Create main layout with header row for invert checkbox
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(8, 6, 8, 8)  # Compact padding for no-scroll fit
        
        # Header row with invert checkbox aligned to right
        header_row = QHBoxLayout()
        header_row.addStretch(1)  # Push checkbox to the right
        self.halftone_invert_chk = QCheckBox("invert")
        self.halftone_invert_chk.setChecked(False)
        self.halftone_invert_chk.stateChanged.connect(lambda _v: (self._mark_halftone_dirty(), self._on_control_changed()))
        header_row.addWidget(self.halftone_invert_chk)
        main_layout.addLayout(header_row)
        
        # Vertical layout for bigger sliders - one on top of each other
        sliders_layout = QVBoxLayout()
        sliders_layout.setContentsMargins(6, 6, 6, 6)  # Compact padding around sliders
        sliders_layout.setSpacing(6)  # Tighter spacing between sliders

        # Add all sliders vertically for better visibility and easier use
        sliders_layout.addWidget(row_cell)
        sliders_layout.addWidget(row_str)
        sliders_layout.addWidget(row_ht_slice)
        sliders_layout.addWidget(row_ht_vslice)
        
        # Reset button for halftone section
        self.reset_halftone_btn = QPushButton("reset")
        self.reset_halftone_btn.setObjectName("ResetButton")
        self.reset_halftone_btn.clicked.connect(self._reset_halftone_params)
        sliders_layout.addWidget(self.reset_halftone_btn)
        
        main_layout.addLayout(sliders_layout)

        halftone_group.setLayout(main_layout)

        # don't let the group stretch vertically
        halftone_group.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        halftone_group.setStyleSheet("QGroupBox { padding:6px 6px 6px 6px; }")

        # Halftone group: readable title + proper top margin for the label
        halftone_group.setStyleSheet("""
        QGroupBox {
            /* give the title room to draw and a bit of inner padding */
            margin-top: 16px;
            padding: 8px 8px 8px 8px;
        }
        QGroupBox::title {
            subcontrol-origin: margin;  /* anchor title in the margin area above the frame */
            left: 8px;                  /* indent from left edge */
            padding: 0 6px;             /* small pill so text doesn't touch the frame */
            font-size: 12px;            /* bump size for legibility in dark UI */
            font-weight: 500;
            color: #e6e6e6;
        }
        """)

        # --- REGISTRATION GROUP ---
        def px_to_in(px): return px / self._working_dpi()
        def fmt_px_in(v): return f"{px_to_in(v):.2f}in"
        reg_size_row,   self.reg_size_s,   self.reg_size_lbl   = row("reg size", 20, 600, 120, lambda v: fmt_px_in(v), on_change_cb=self._on_regs_changed)
        reg_offset_row, self.reg_offset_s, self.reg_offset_lbl = row("reg offset", 10, 1000, int(1.0*self._working_dpi()), lambda v: fmt_px_in(v), on_change_cb=self._on_regs_changed)
        reg_thick_row,  self.reg_thick_s,  self.reg_thick_lbl  = row("reg weight", 10, 300, 100, lambda v: f"{v}%", on_change_cb=self._on_regs_changed)

        reg_row1 = QHBoxLayout()
        self.regs_chk = QCheckBox("add reg marks"); self.regs_chk.setChecked(True)
        self.regs_chk.stateChanged.connect(lambda _v: self._on_regs_changed())
        self.load_reg_btn = QPushButton("load reg mark…"); self.load_reg_btn.clicked.connect(self.on_load_reg)
        if not HAS_SVGPATHTOOLS:
            self.load_reg_btn.setEnabled(False)
            self.load_reg_btn.setToolTip("Install 'svgpathtools' to load a custom reg mark SVG.")
        reg_row1.addWidget(self.regs_chk); reg_row1.addWidget(self.load_reg_btn); reg_row1.addStretch(1)

        registration_group = QGroupBox("registration")
        _reg_v = QVBoxLayout()
        _reg_v.setSpacing(6)                        # Compact vertical spacing
        _reg_v.setContentsMargins(8, 6, 8, 8)       # Tighter margins for better fit
        _reg_v.addLayout(reg_row1)
        _reg_v.addLayout(reg_size_row)
        _reg_v.addLayout(reg_offset_row)
        _reg_v.addLayout(reg_thick_row)
        
        # Reset button for registration section
        self.reset_registration_btn = QPushButton("reset")
        self.reset_registration_btn.setObjectName("ResetButton")
        self.reset_registration_btn.clicked.connect(self._reset_registration_params)
        _reg_v.addWidget(self.reset_registration_btn)
        
        registration_group.setLayout(_reg_v)

        # --- CMYK + HALFTONE PANEL — presets + dot shape (left) | dials + moiré (right) ---
        cmyk_panel = QGroupBox("cmyk angles")
        # make CMYK angles group tight + readable
        cmyk_panel.setStyleSheet("""
        QGroupBox {
            margin-top: 12px;   /* space for the title above the frame (smaller) */
            padding: 6px;       /* reduce inner padding so it sits higher */
        }
        QGroupBox::title {
            subcontrol-origin: margin;
            left: 8px;
            padding: 0 6px;
            font-size: 12px;
            font-weight: 500;
            color: #e6e6e6;
        }
        """)

        # also make the layout inside the CMYK group more compact
        _cp = cmyk_panel.layout()
        if _cp is not None:
            _cp.setContentsMargins(8, 6, 8, 8)   # Reduced margins
            _cp.setSpacing(8)                    # Tighter spacing

        cmyk_panel.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

        panel_row = QHBoxLayout(); panel_row.setSpacing(12)  # Reduced spacing between columns
        panel_row.setContentsMargins(0, 0, 0, 0)

        # LEFT: presets + dot-shape controls
        controls_col = QVBoxLayout(); controls_col.setSpacing(8)  # Reduced spacing
        controls_col.setContentsMargins(0, 0, 8, 0)   # Reduced margin

        presets_row = QHBoxLayout()
        presets_row.addWidget(QLabel("presets"))
        self.preset_combo = QComboBox()
        for name in self.PRESETS.keys():          # self.PRESETS is already defined above
            self.preset_combo.addItem(name)
        self.preset_combo.currentTextChanged.connect(self._apply_preset)
        self.preset_combo.setMaximumWidth(140)     # Smaller for no-scroll fit
        presets_row.addWidget(self.preset_combo, 1)
        controls_col.addLayout(presets_row)

        # dot-shape controls now live under presets
        dotshape_row = QHBoxLayout()
        self.load_shape_btn = QPushButton("load dot shape…"); self.load_shape_btn.clicked.connect(self.on_load_shape)
        self.shape_rot_chk = QCheckBox("rotate shape with grid"); self.shape_rot_chk.setChecked(False)
        self.shape_rot_chk.stateChanged.connect(
            lambda _v: (
                setattr(self, 'rotate_shape', self.shape_rot_chk.isChecked()),
                self._clear_sprite_caches(),
                self._mark_halftone_dirty(),
                self._on_control_changed(),
                self._schedule_moire_update()
            )
        )
        if not HAS_SVGPATHTOOLS:
            self.load_shape_btn.setEnabled(False)
            self.load_shape_btn.setToolTip("Install 'svgpathtools' to use custom shapes.")
        dotshape_row.addWidget(self.load_shape_btn)
        dotshape_row.addWidget(self.shape_rot_chk)
        dotshape_row.addStretch(1)
        controls_col.addLayout(dotshape_row)

        panel_row.addLayout(controls_col, 0)

        # RIGHT: dials + moiré tile
        right_col = QHBoxLayout()
        right_col.setSpacing(20)                       # Reduced further for compact fit
        right_col.setContentsMargins(0, 0, 0, 0)

        def make_dial(obj_name: str, init: int):
            dial = QDial(); dial.setRange(0, 180); dial.setValue(init)
            dial.setNotchesVisible(True)
            dial.setFixedSize(38, 38)                 # Smaller dials to fit better
            dial.setObjectName(obj_name)
            lab = QLabel(f"{init}°"); lab.setAlignment(Qt.AlignmentFlag.AlignCenter); lab.setFixedWidth(38)
            def on_change(v, lab=lab):
                lab.setText(f"{v}°")
                self._mark_halftone_dirty()
                if self.interacting:
                    if hasattr(self, '_interact_timer'):
                        self._interact_timer.stop()
                        self._interact_timer.start(30)
                else:
                    self._on_control_changed()
                    self._schedule_moire_update()
            dial.valueChanged.connect(on_change)
            dial.sliderPressed.connect(self._on_slider_pressed)
            dial.sliderReleased.connect(self._on_slider_released)
            return dial, lab

        dials_grid = QGridLayout()
        dials_grid.setVerticalSpacing(4)              # Tighter spacing
        dials_grid.setHorizontalSpacing(12)           # Reduced for compact fit
        dials_grid.setContentsMargins(0, 0, 0, 0)

        self.ang_c, lc = make_dial("dialC", 15)
        self.ang_m, lm = make_dial("dialM", 75)
        self.ang_y, ly = make_dial("dialY", 0)
        self.ang_k, lk = make_dial("dialK", 45)
        dials_grid.addWidget(self.ang_c, 0, 0); dials_grid.addWidget(lc, 1, 0)
        dials_grid.addWidget(self.ang_m, 0, 1); dials_grid.addWidget(lm, 1, 1)
        dials_grid.addWidget(self.ang_y, 2, 0); dials_grid.addWidget(ly, 3, 0)
        dials_grid.addWidget(self.ang_k, 2, 1); dials_grid.addWidget(lk, 3, 1)

        # Real-time preview enhancements - Channel isolation controls
        isolation_row = QHBoxLayout()
        isolation_row.setContentsMargins(0, 4, 0, 0)
        isolation_lab = QLabel("isolate:"); isolation_lab.setStyleSheet("font-size: 10px; color: #aaa;")
        isolation_row.addWidget(isolation_lab)
        
        # Channel solo buttons for real-time preview
        self.channel_solo_buttons = {}
        for ch, color in [('c', '#00ffff'), ('m', '#ff00ff'), ('y', '#ffff00'), ('k', '#000000')]:
            btn = QPushButton(ch.upper())
            btn.setFixedSize(18, 14)  # Smaller buttons for compact fit
            btn.setCheckable(True)
            btn.setStyleSheet(f"""
                QPushButton {{ 
                    font-size: 8px; font-weight: bold; border: 1px solid #555; 
                    background: #333; color: {color}; border-radius: 2px; 
                }}
                QPushButton:checked {{ 
                    background: {color}; color: #000; border-color: #fff; 
                }}
                QPushButton:hover {{ border-color: #888; }}
            """)
            btn.clicked.connect(lambda checked, channel=ch: self._on_channel_solo(channel, checked))
            self.channel_solo_buttons[ch] = btn
            isolation_row.addWidget(btn)
        
        isolation_row.addStretch(1)
        
        # Add to dials column
        dials_container = QVBoxLayout()
        dials_container.addLayout(dials_grid)
        dials_container.addLayout(isolation_row)

        # moiré preview
        self.moire_lbl = QLabel()
        self.moire_lbl.setObjectName("MoireBox")
        self.moire_lbl.setFixedSize(80, 80)  # Smaller for compact fit

        # key changes: no stretch on the dials, center-align the tile, then push leftover space to the far right
        right_col.addLayout(dials_container, 0)
        right_col.addWidget(self.moire_lbl, 0, Qt.AlignmentFlag.AlignVCenter)
        right_col.addStretch(1)

        panel_row.addLayout(right_col, 1)

        cmyk_panel.setLayout(panel_row)


        # --- TOOLBOX (ORDER YOU ASKED) ---
        # 1) cmyk + halftone  2) glitch fx  3) registration
        cmyk_halftone_page = QWidget()
        self.cmyk_halftone_page = cmyk_halftone_page  # Store ref for diffusion mutual exclusion
        _cmyk_halftone_v = QVBoxLayout(cmyk_halftone_page)
        _cmyk_halftone_v.setSpacing(4)  # Compact spacing for no-scroll fit
        _cmyk_halftone_v.setContentsMargins(6, 4, 6, 4)  # Tight margins

        cmyk_halftone_stack = QWidget()
        _stack_v = QVBoxLayout(cmyk_halftone_stack)
        _stack_v.setContentsMargins(0, 0, 0, 0)
        _stack_v.setSpacing(8)  # Comfortable spacing between groups

        # Scoped lighter padding so titles don't float
        try:
            cmyk_panel.setStyleSheet("QGroupBox { margin-top:4px; padding:4px; } QGroupBox::title { subcontrol-origin: margin; left:8px; padding:0 6px; font-size:12px; font-weight:500; }")
            halftone_group.setStyleSheet("QGroupBox { margin-top:4px; padding:4px; } QGroupBox::title { subcontrol-origin: margin; left:8px; padding:0 6px; font-size:12px; font-weight:500; }")
        except Exception:
            pass

        # Keep groups from stretching vertically (prevents voids)
        try:
            cmyk_panel.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
            halftone_group.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        except Exception:
            pass

        cmyk_halftone_stack = QWidget()
        _stack_v = QVBoxLayout(cmyk_halftone_stack)
        _stack_v.setContentsMargins(0, 0, 0, 0)  # absolute zero outer padding
        _stack_v.setSpacing(2)                   # tiny internal gap
        
        # Add sections in order: angles, then halftone
        _stack_v.addWidget(cmyk_panel)
        _stack_v.addWidget(halftone_group)
        _cmyk_halftone_v.addWidget(cmyk_halftone_stack)

        # --- ASCII ART GROUP ---
        ascii_group = QGroupBox("ascii art")
        ascii_main_layout = QVBoxLayout()
        ascii_main_layout.setContentsMargins(6, 6, 6, 6)
        
        # Header row with invert checkbox
        ascii_header_row = QHBoxLayout()
        ascii_header_row.addStretch(1)
        self.ascii_invert_chk = QCheckBox("invert")
        self.ascii_invert_chk.setChecked(False)
        self.ascii_invert_chk.stateChanged.connect(lambda _v: (self._mark_halftone_dirty(), self._on_control_changed()))
        ascii_header_row.addWidget(self.ascii_invert_chk)
        ascii_main_layout.addLayout(ascii_header_row)
        
        ascii_layout = QVBoxLayout()
        ascii_layout.setContentsMargins(0, 0, 0, 0)
        
        # Enable ASCII art checkbox
        self.ascii_enabled_chk = QCheckBox("enable ascii art mode")
        self.ascii_enabled_chk.setChecked(False)
        self.ascii_enabled_chk.stateChanged.connect(lambda _v: (self._mark_halftone_dirty(), self._on_control_changed(), self._on_ascii_enabled_changed()))
        ascii_layout.addWidget(self.ascii_enabled_chk)
        
        # Character set dropdown
        charset_row = QHBoxLayout()
        charset_row.addWidget(QLabel("character set"))
        self.ascii_charset_combo = QComboBox()
        self.ascii_charset_combo.addItems([
            "default",           # Standard ASCII gradient: .:-=+*#%@
            "slashes",           # ////....----\\\\
            "emoticons",         # :) :( :D ;) :P
            "symbols",           # (){}[]<>
            "blocks",            # ░▒▓█
            "dots",              # ·•●○◦
            "geometric",         # △▽○□◇
            "brackets",          # ((())){{{}}}[[[]]]
            "waves",             # ~≈≋∿
            "custom"             # User-defined
        ])
        self.ascii_charset_combo.currentTextChanged.connect(self._on_ascii_charset_changed)
        charset_row.addWidget(self.ascii_charset_combo)
        ascii_layout.addLayout(charset_row)
        
        # Custom characters input (shown only when "custom" is selected)
        custom_row = QHBoxLayout()
        custom_row.addWidget(QLabel("custom chars"))
        self.ascii_custom_input = QLineEdit()
        self.ascii_custom_input.setPlaceholderText("light → dark (e.g., .:-=+*#%@)")
        self.ascii_custom_input.textChanged.connect(lambda _: (self._mark_halftone_dirty(), self._on_control_changed()))
        custom_row.addWidget(self.ascii_custom_input)
        ascii_layout.addLayout(custom_row)
        self.ascii_custom_row_widget = QWidget()
        custom_row_container = QHBoxLayout(self.ascii_custom_row_widget)
        custom_row_container.setContentsMargins(0, 0, 0, 0)
        custom_row_container.addWidget(QLabel("custom chars"))
        custom_row_container.addWidget(self.ascii_custom_input)
        self.ascii_custom_row_widget.setVisible(False)  # Hidden by default
        ascii_layout.addWidget(self.ascii_custom_row_widget)
        
        # Cell size slider
        cell_size_row, self.ascii_cell_size_s, self.ascii_cell_size_lbl = row("cell size", 4, 32, 10, lambda x: f"{x}px")
        ascii_layout.addLayout(cell_size_row)
        
        # Font size slider
        font_size_row, self.ascii_font_size_s, self.ascii_font_size_lbl = row("font size", 4, 24, 10, lambda x: f"{x}pt")
        ascii_layout.addLayout(font_size_row)
        
        # Threshold levels slider
        threshold_row, self.ascii_threshold_s, self.ascii_threshold_lbl = row("threshold levels", 2, 20, 10, lambda x: f"{x}")
        ascii_layout.addLayout(threshold_row)
        
        # Line spacing slider
        spacing_row, self.ascii_spacing_s, self.ascii_spacing_lbl = row("line spacing", 50, 200, 100, lambda x: f"{x/100:.1f}x")
        ascii_layout.addLayout(spacing_row)
        
        # SVG export option: keep text editable
        self.ascii_keep_text_chk = QCheckBox("keep text editable in SVG (font-dependent)")
        self.ascii_keep_text_chk.setChecked(False)
        self.ascii_keep_text_chk.setToolTip("If checked, SVG exports use <text> elements (editable in Illustrator but requires font).\nIf unchecked, text is converted to vector paths (font-independent, screen-print ready).")
        ascii_layout.addWidget(self.ascii_keep_text_chk)
        
        # Reset button
        self.reset_ascii_btn = QPushButton("reset")
        self.reset_ascii_btn.setObjectName("ResetButton")
        self.reset_ascii_btn.clicked.connect(self._reset_ascii_params)
        ascii_layout.addWidget(self.reset_ascii_btn)
        
        ascii_main_layout.addLayout(ascii_layout)
        ascii_group.setLayout(ascii_main_layout)
        
        toolbox = QToolBox()
        toolbox.addItem(cmyk_halftone_page, "cmyk + halftone")
        toolbox.addItem(line_controls_page, "lines")
        toolbox.addItem(glitch_group, "glitch fx")
        toolbox.addItem(diffusion_group, "diffusion")
        toolbox.addItem(ascii_group, "ascii art")
        toolbox.addItem(registration_group, "registration")
        
        self.toolbox = toolbox  # Store reference for potential future use

        # --- Pixelate controls (above toolbox, below overview) ---
        pixelate_row = QHBoxLayout()
        pixelate_row.setSpacing(8)
        self.pixelate_enabled_chk = QCheckBox("pixelate")
        self.pixelate_enabled_chk.stateChanged.connect(self._on_pixelate_toggled)
        pixelate_row.addWidget(self.pixelate_enabled_chk)
        pixelate_row.addWidget(QLabel("block"))
        self.pixelate_block_s = QSlider(Qt.Orientation.Horizontal)
        self.pixelate_block_s.setRange(4, 120)
        self.pixelate_block_s.setValue(20)
        self.pixelate_block_s.setFixedWidth(100)
        self.pixelate_block_s.valueChanged.connect(lambda v: (self.pixelate_block_lbl.setText(f"{v}px"), self._throttled_slider_update()))
        self.pixelate_block_s.sliderPressed.connect(self._on_slider_pressed)
        self.pixelate_block_s.sliderReleased.connect(self._on_slider_released)
        self.pixelate_block_lbl = QLabel("20px")
        pixelate_row.addWidget(self.pixelate_block_s)
        pixelate_row.addWidget(self.pixelate_block_lbl)
        pixelate_row.addStretch(1)

        # --- LAYER PANEL ---
        from PySide6.QtWidgets import QListWidget, QListWidgetItem, QAbstractItemView, QScrollBar
        layer_group = QGroupBox("layers")
        layer_layout = QVBoxLayout()
        layer_layout.setContentsMargins(4, 4, 4, 4)
        layer_layout.setSpacing(4)
        self.layer_list = QListWidget()
        self.layer_list.setMaximumHeight(72)
        self.layer_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.layer_list.currentRowChanged.connect(self._on_layer_selected)
        layer_layout.addWidget(self.layer_list)
        layer_btn_row = QHBoxLayout()
        layer_vis_btn = QPushButton("\U0001f441"); layer_vis_btn.setFixedWidth(28)
        layer_vis_btn.setToolTip("toggle visibility"); layer_vis_btn.clicked.connect(self._on_layer_toggle_vis)
        layer_lock_btn = QPushButton("\U0001f513"); layer_lock_btn.setFixedWidth(28)
        layer_lock_btn.setToolTip("lock/unlock layer"); layer_lock_btn.clicked.connect(self._on_layer_toggle_lock)
        self._layer_lock_btn = layer_lock_btn
        layer_up_btn = QPushButton("\u25b2"); layer_up_btn.setFixedWidth(28)
        layer_up_btn.setToolTip("move up"); layer_up_btn.clicked.connect(self._on_layer_move_up)
        layer_dn_btn = QPushButton("\u25bc"); layer_dn_btn.setFixedWidth(28)
        layer_dn_btn.setToolTip("move down"); layer_dn_btn.clicked.connect(self._on_layer_move_down)
        layer_del_btn = QPushButton("\u2715"); layer_del_btn.setFixedWidth(28)
        layer_del_btn.setToolTip("remove layer"); layer_del_btn.clicked.connect(self._on_layer_remove)
        layer_btn_row.addWidget(layer_vis_btn)
        layer_btn_row.addWidget(layer_lock_btn)
        layer_btn_row.addWidget(layer_up_btn)
        layer_btn_row.addWidget(layer_dn_btn)
        layer_btn_row.addStretch()
        layer_btn_row.addWidget(layer_del_btn)
        layer_layout.addLayout(layer_btn_row)
        layer_group.setLayout(layer_layout)

        # --- LEFT COLUMN (NO artboard here now) ---
        left = QVBoxLayout(); left.setSpacing(6)
        left.addLayout(toolbar)
        left.addWidget(header_group)     # overview
        left.addLayout(pixelate_row)     # pixelate toggle + block size
        left.addWidget(toolbox, 1)       # toolbox (cmyk+halftone, glitch, registration)
        left.addWidget(layer_group)      # layers panel (below accordion)
        self.info = QLabel(""); self.info.setStyleSheet("color:#bbb;")
        left.addWidget(self.info, 0)
        left_w = QWidget(); left_w.setLayout(left)
        left_w.setMinimumWidth(520)

        # --- RIGHT COLUMN — Artboard above Preview with Scrollbars ---
        self.prev_lbl = PreviewArea(self, self.on_wheel_zoom, self.on_drag_delta, self._artboard_size_px_from_transform)
        # Connect flow path signal
        self.prev_lbl.flowPathChanged.connect(self._on_flow_path_drawn)

        self._h_scroll = QScrollBar(Qt.Orientation.Horizontal)
        self._v_scroll = QScrollBar(Qt.Orientation.Vertical)
        self._h_scroll.setFixedHeight(10)
        self._v_scroll.setFixedWidth(10)
        _slim_h_ss = ("QScrollBar:horizontal{height:10px;background:#333;}"
            "QScrollBar::handle:horizontal{background:#666;border-radius:4px;min-width:20px;}"
            "QScrollBar::add-line:horizontal,QScrollBar::sub-line:horizontal{width:0px;}"
            "QScrollBar::add-page:horizontal,QScrollBar::sub-page:horizontal{background:#333;}")
        _slim_v_ss = ("QScrollBar:vertical{width:10px;background:#333;}"
            "QScrollBar::handle:vertical{background:#666;border-radius:4px;min-height:20px;}"
            "QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical{height:0px;}"
            "QScrollBar::add-page:vertical,QScrollBar::sub-page:vertical{background:#333;}")
        self._h_scroll.setStyleSheet(_slim_h_ss)
        self._v_scroll.setStyleSheet(_slim_v_ss)
        self._h_scroll.valueChanged.connect(self._on_hscroll)
        self._v_scroll.valueChanged.connect(self._on_vscroll)
        self._scroll_updating = False

        preview_grid = QGridLayout()
        preview_grid.setContentsMargins(0, 0, 0, 0)
        preview_grid.setSpacing(0)
        preview_grid.addWidget(self.prev_lbl, 0, 0)
        preview_grid.addWidget(self._v_scroll, 0, 1)
        preview_grid.addWidget(self._h_scroll, 1, 0)
        preview_container = QWidget()
        preview_container.setLayout(preview_grid)

        # --- BG COLOR INDICATOR (bottom-left overlay on preview) ---
        self._bg_color_box = QPushButton(self.prev_lbl)
        self._bg_color_box.setFixedSize(28, 28)
        self._bg_color_box.setCursor(Qt.CursorShape.PointingHandCursor)
        self._bg_color_box.clicked.connect(self._toggle_bg_color)
        self._bg_color_box.setToolTip("toggle background color")
        self._update_bg_color_box()
        self._bg_color_box.raise_()

        # --- ARTBOARD INFO OVERLAY (bottom-right of preview) ---
        self._artboard_info_label = QLabel(self.prev_lbl)
        self._artboard_info_label.setStyleSheet(
            "color:#aaa; background:rgba(50,50,50,180); padding:2px 8px;"
            "border-radius:4px; font-size:9pt;")
        self._artboard_info_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._artboard_info_label.adjustSize()
        self._artboard_info_label.raise_()

        right = QVBoxLayout()
        right.addWidget(self.art_group)          # <— artboard group on top
        right.addWidget(preview_container, 1)    # <— preview + scrollbars
        right_w = QWidget(); right_w.setLayout(right)

        # --- Splitter ---
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(left_w)
        splitter.addWidget(right_w)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([560, 760])

        # --- Root ---
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(0, 0, 0, 0)
        root_layout.setSpacing(0)
        root_layout.addWidget(splitter)

        # --- Bottom bar: screenshot + record ---
        bottom_bar = QWidget()
        bottom_bar.setFixedHeight(44)
        bottom_bar.setStyleSheet("background:#2e2f31; border-top:1px solid #555;")
        bottom_row = QHBoxLayout(bottom_bar)
        bottom_row.setContentsMargins(8, 4, 8, 4)
        bottom_row.addStretch(1)
        self.screenshot_btn = QPushButton("screenshot")
        self.screenshot_btn.setFixedWidth(130)
        self.screenshot_btn.clicked.connect(self._on_screenshot)
        self.record_btn = QPushButton("●  record")
        self.record_btn.setFixedWidth(130)
        self.record_btn.clicked.connect(self._on_record_toggle)
        if not HAS_OPENCV:
            self.record_btn.setEnabled(False)
            self.record_btn.setToolTip("install 'opencv-python' to enable screen recording.")
        bottom_row.addWidget(self.screenshot_btn)
        bottom_row.addSpacing(12)
        bottom_row.addWidget(self.record_btn)
        bottom_row.addStretch(1)
        root_layout.addWidget(bottom_bar)

        self.setCentralWidget(root)

        self.statusBar().showMessage("ready")
        if os.path.isfile(ICON_PATH):
            if _load_app_icon() is not None:
                self.statusBar().showMessage(f"icon loaded: {ICON_PATH}")
            else:
                self.statusBar().showMessage(f"icon found but failed to load (null): {ICON_PATH}")
        else:
            self.statusBar().showMessage(f"icon not found at: {ICON_PATH}")

        self.setStyleSheet(QSS)
        self.prev_lbl.set_zoom(1.0)
        self._refresh_gray_ui()
        self._update_titles()
        self._schedule_moire_update()

        # --- KEYBOARD SHORTCUTS ---
        QShortcut(QKeySequence("Ctrl+Z"), self, self.on_undo)
        QShortcut(QKeySequence("Ctrl+Shift+Z"), self, self.on_redo)
        QShortcut(QKeySequence("Ctrl+Y"), self, self.on_redo)
        QShortcut(QKeySequence("Ctrl+S"), self, self.on_save_project)
        QShortcut(QKeySequence("Ctrl+Shift+S"), self, self.on_save_project_as)
        QShortcut(QKeySequence("Ctrl+O"), self, self.on_open)

        # Initialize preview with empty artboard
        self.update_preview(force=True)

    def _on_preview_channel_changed(self, _text):
        self._mark_halftone_dirty()
        self._on_control_changed()
        self._update_preview_channel_visibility()

    def _on_full_composite_changed(self, _state):
        self._mark_halftone_dirty()
        self._on_control_changed()
        self._update_preview_channel_visibility()
    
    def _update_preview_channel_visibility(self):
        """Update preview channel selector visibility/style based on full_composite state."""
        is_single_channel = not self.full_comp.isChecked() and not self.gray_chk.isChecked()
        if is_single_channel:
            # Highlight the preview channel selector when it affects export
            self.preview_chan.setStyleSheet("QComboBox { background-color: #4a4a6a; border: 2px solid #7070a0; }")
            self.preview_chan.setToolTip("Select channel to preview AND export (full composite is OFF)")
        else:
            # Normal style when full composite is on or B/W mode
            self.preview_chan.setStyleSheet("")
            self.preview_chan.setToolTip("Select channel to preview")

    def _on_gray_toggled(self, _state):
        self._refresh_gray_ui()
        self._mark_halftone_dirty()
        self._on_control_changed()
        self._schedule_moire_update()
        self._update_preview_channel_visibility()

    def _on_pixelate_toggled(self, _state):
        """Toggle pixelate on/off."""
        self._mark_halftone_dirty()
        self._on_control_changed()

    def _on_diffusion_toggled(self, _state):
        """Toggle diffusion on/off \u2014 mutually exclusive with halftone panel."""
        enabled = self.diffusion_enabled_chk.isChecked()
        # Disable/enable the cmyk + halftone page
        if hasattr(self, 'cmyk_halftone_page'):
            self.cmyk_halftone_page.setEnabled(not enabled)
        self._mark_halftone_dirty()
        self._on_control_changed()

    def _on_diffusion_changed(self, _state):
        self._mark_halftone_dirty()
        self._on_control_changed()
    
    def _on_flow_path_toggle(self, state):
        """Handle flow path enable/disable toggle"""
        self._mark_halftone_dirty()
        self.update_preview(force=True)
    
    def _on_draw_flow_path_clicked(self, checked):
        """Handle draw flow path button click"""
        if self.prev_lbl is not None:
            self.prev_lbl.set_flow_path_draw_mode(checked)
            if checked:
                self.draw_flow_path_btn.setText("Drawing...")
            else:
                self.draw_flow_path_btn.setText("Draw Path")
    
    def _on_clear_flow_path_clicked(self):
        """Handle clear flow path button click"""
        self._lines_flow_path = []
        if self.prev_lbl is not None:
            self.prev_lbl.clear_flow_path()
        self._mark_halftone_dirty()
        self.update_preview(force=True)
    
    def _on_show_flow_path_changed(self, state):
        """Handle show flow path checkbox toggle"""
        if self.prev_lbl is not None:
            self.prev_lbl.set_show_flow_path(state == Qt.CheckState.Checked.value or state == 2)
    
    def _on_flow_path_drawn(self, points: List[Tuple[float, float]]):
        """Handle completion of flow path drawing"""
        self._lines_flow_path = points
        # Exit draw mode
        self.draw_flow_path_btn.setChecked(False)
        self.draw_flow_path_btn.setText("Draw Path")
        if self.prev_lbl is not None:
            self.prev_lbl.set_flow_path_draw_mode(False)
        # Trigger re-render if flow path is enabled
        if self.lines_use_flow_path_chk.isChecked():
            self._mark_halftone_dirty()
            self.update_preview(force=True)

    def on_wheel_zoom(self, d: int):
        step = 5
        self.zoom.setValue(max(self.zoom.minimum(), min(self.zoom.maximum(), self.zoom.value() + (step if d > 0 else -step))))

    # ===== Logic below matches previous builds =====

    def _reset_glitch_params(self):
        self.slice_shift_s.setValue(0); self.warp_amt_s.setValue(0); self.warp_scale_s.setValue(100)
        if hasattr(self, 'slice_size_s'): self.slice_size_s.setValue(20)
        if hasattr(self, 'slice_angle_s'): self.slice_angle_s.setValue(0)
        if hasattr(self, 'vertical_slice_size_s'): self.vertical_slice_size_s.setValue(20)
        if hasattr(self, 'vertical_slice_angle_s'): self.vertical_slice_angle_s.setValue(0)
        # Reset diffusion glitch effects
        if hasattr(self, 'broken_kernel_s'): self.broken_kernel_s.setValue(0)
        if hasattr(self, 'dir_bias_s'): self.dir_bias_s.setValue(0)
        if hasattr(self, 'dir_bias_angle_s'): self.dir_bias_angle_s.setValue(0)
        if hasattr(self, 'error_overflow_s'): self.error_overflow_s.setValue(0)
        if hasattr(self, 'diffusion_reset_s'): self.diffusion_reset_s.setValue(0)
        if hasattr(self, 'cross_bleed_s'): self.cross_bleed_s.setValue(0)
        # Reset datamosh effects
        if hasattr(self, 'block_shift_s'): self.block_shift_s.setValue(0)
        if hasattr(self, 'block_size_s'): self.block_size_s.setValue(16)
        if hasattr(self, 'chan_desync_s'): self.chan_desync_s.setValue(0)
        if hasattr(self, 'bitmap_sort_s'): self.bitmap_sort_s.setValue(0)
        if hasattr(self, 'bitmap_sort_vert_chk'): self.bitmap_sort_vert_chk.setChecked(False)
        if hasattr(self, 'smear_drag_s'): self.smear_drag_s.setValue(0)
        if hasattr(self, 'smear_length_s'): self.smear_length_s.setValue(24)
        if hasattr(self, 'smear_vertical_chk'): self.smear_vertical_chk.setChecked(False)
        if hasattr(self, 'macroblock_s'): self.macroblock_s.setValue(0)
        if hasattr(self, 'macroblock_dropout_s'): self.macroblock_dropout_s.setValue(25)
        for ch in "cmyk":
            self.disp_sliders[ch][0].setValue(0)
            self.disp_sliders[ch][1].setValue(0)
        # Reset stereogram
        if hasattr(self, 'stereo_mode_chk'): self.stereo_mode_chk.setChecked(False)
        if hasattr(self, 'stereo_depth_s'): self.stereo_depth_s.setValue(50)
        if hasattr(self, 'stereo_sep_s'): self.stereo_sep_s.setValue(60)
        if hasattr(self, 'stereo_smooth_s'): self.stereo_smooth_s.setValue(30)
        if hasattr(self, 'stereo_dot_s'): self.stereo_dot_s.setValue(4)
        if hasattr(self, 'stereo_fray_x_s'): self.stereo_fray_x_s.setValue(0)
        if hasattr(self, 'stereo_fray_y_s'): self.stereo_fray_y_s.setValue(0)
        if hasattr(self, 'stereo_offset_s'): self.stereo_offset_s.setValue(0)
        if hasattr(self, 'stereo_invert_chk'): self.stereo_invert_chk.setChecked(False)
        if hasattr(self, 'stereo_pattern_combo'): self.stereo_pattern_combo.setCurrentText("random dots")
        if hasattr(self, 'stereo_colors_combo'): self.stereo_colors_combo.setCurrentText("3-color (CMY)")
        self.stereo_color_c_hex = "#00FFFF"; self.stereo_color_m_hex = "#FF00FF"
        self.stereo_color_y_hex = "#FFFF00"; self.stereo_color_k_hex = "#000000"
        if hasattr(self, 'btn_stereo_c'): self.btn_stereo_c.setStyleSheet("background-color: cyan;")
        if hasattr(self, 'btn_stereo_m'): self.btn_stereo_m.setStyleSheet("background-color: magenta;")
        if hasattr(self, 'btn_stereo_y'): self.btn_stereo_y.setStyleSheet("background-color: yellow;")
        if hasattr(self, 'btn_stereo_k'): self.btn_stereo_k.setStyleSheet("background-color: black; color: white;")
        if hasattr(self, 'stereo_core'): self.stereo_core.clear_caches()
        self._noise_cache.clear(); self._grid_cache.clear()
        self._mark_halftone_dirty(); self.update_preview(force=True)
    
    def _on_stereo_mode_changed(self, state=None):
        self.stereo_core.clear_caches()
        self._mark_halftone_dirty()
        self._on_control_changed()

    def _on_stereo_control_changed(self, *args):
        self.stereo_core.clear_caches()
        self._mark_halftone_dirty()
        self._on_control_changed()

    def _pick_stereo_color(self, channel: str):
        from PySide6.QtWidgets import QColorDialog
        current_hex = getattr(self, f'stereo_color_{channel}_hex')
        hex_str = current_hex.lstrip('#')
        r, g, b = (int(hex_str[i:i+2], 16) for i in (0, 2, 4))
        color = QColorDialog.getColor(QColor(r, g, b), self, f"Pick {channel.upper()} Color")
        if color.isValid():
            new_hex = f"#{color.red():02X}{color.green():02X}{color.blue():02X}"
            setattr(self, f'stereo_color_{channel}_hex', new_hex)
            btn = getattr(self, f'btn_stereo_{channel}')
            text_color = "white" if (color.red() + color.green() + color.blue()) < 384 else "black"
            btn.setStyleSheet(f"background-color: rgb({color.red()},{color.green()},{color.blue()}); color: {text_color};")
            self._on_stereo_control_changed()

    def _reset_pixelate_params(self):
        """Reset pixelate parameters to default values"""
        self.pixelate_enabled_chk.setChecked(False)
        self.pixelate_block_s.setValue(20)
        self._mark_halftone_dirty(); self.update_preview(force=True)

    def _reset_lines_params(self):
        """Reset lines control parameters to default values"""
        if hasattr(self, 'line_length_s'): self.line_length_s.setValue(100)
        if hasattr(self, 'line_width_s'): self.line_width_s.setValue(100)
        if hasattr(self, 'line_weight_s'): self.line_weight_s.setValue(25)  # Default weight variation
        if hasattr(self, 'line_density_s'): self.line_density_s.setValue(100)
        if hasattr(self, 'line_taper_s'): self.line_taper_s.setValue(15)  # Default line taper
        if hasattr(self, 'stroke_random_s'): self.stroke_random_s.setValue(10)  # Default randomness
        if hasattr(self, 'lines_invert_chk'): self.lines_invert_chk.setChecked(False)
        # Reset flow path controls
        if hasattr(self, 'lines_use_flow_path_chk'): self.lines_use_flow_path_chk.setChecked(False)
        if hasattr(self, 'lines_path_influence_s'): self.lines_path_influence_s.setValue(100)
        if hasattr(self, 'show_flow_path_chk'): self.show_flow_path_chk.setChecked(True)
        self._on_clear_flow_path_clicked()  # Clear the path
        self._mark_halftone_dirty(); self.update_preview(force=True)

    def _reset_diffusion_params(self):
        """Reset diffusion parameters to default values"""
        self.diffusion_enabled_chk.setChecked(False)
        self.diffusion_invert_chk.setChecked(False)
        self.diffusion_algo_combo.setCurrentText("floyd-steinberg")
        self.diffusion_intensity_s.setValue(50)
        self.diffusion_levels_s.setValue(8)
        self.diffusion_sharpen_s.setValue(0)
        self.diffusion_radius_s.setValue(1)
        self.diffusion_denoise_s.setValue(0)
        if hasattr(self, 'diffusion_mod_combo'):
            self.diffusion_mod_combo.setCurrentText("none")
        if hasattr(self, 'diffusion_mod_strength_s'):
            self.diffusion_mod_strength_s.setValue(50)
        # Re-enable halftone panel
        if hasattr(self, 'cmyk_halftone_page'):
            self.cmyk_halftone_page.setEnabled(True)
        self._mark_halftone_dirty(); self.update_preview(force=True)

    def _reset_halftone_params(self):
        """Reset halftone parameters to default values"""
        self.halftone_invert_chk.setChecked(False)
        self.cell_s.setValue(1600)
        self.str_s.setValue(100)
        # Reset halftone sliders to defaults
        for ch in "cmyk":
            if hasattr(self, f'{ch}_cell_s'): getattr(self, f'{ch}_cell_s').setValue(1600)
            if hasattr(self, f'{ch}_elem_s'): getattr(self, f'{ch}_elem_s').setValue(1)
            if hasattr(self, f'{ch}_gap_s'): getattr(self, f'{ch}_gap_s').setValue(0)
            if hasattr(self, f'{ch}_str_s'): getattr(self, f'{ch}_str_s').setValue(100)
            if hasattr(self, f'{ch}_ctr_s'): getattr(self, f'{ch}_ctr_s').setValue(50)
        self._mark_halftone_dirty(); self.update_preview(force=True)

    def _reset_registration_params(self):
        """Reset registration parameters to default values"""
        self.regs_chk.setChecked(False)
        self.reg_size_s.setValue(15)
        self.reg_offset_s.setValue(15)
        self.reg_thick_s.setValue(100)
        self._sync_registration_to_bg()
        self._mark_halftone_dirty(); self.update_preview(force=True)

    def _reset_ascii_params(self):
        """Reset ASCII art parameters to default values"""
        self.ascii_enabled_chk.setChecked(False)
        self.ascii_invert_chk.setChecked(False)
        self.ascii_charset_combo.setCurrentText("default")
        self.ascii_custom_input.clear()
        self.ascii_cell_size_s.setValue(10)
        self.ascii_font_size_s.setValue(10)
        self.ascii_threshold_s.setValue(10)
        self.ascii_spacing_s.setValue(100)
        self.ascii_keep_text_chk.setChecked(False)
        self._mark_halftone_dirty(); self.update_preview(force=True)

    def _on_ascii_charset_changed(self, text):
        """Handle ASCII charset dropdown change"""
        is_custom = (text == "custom")
        self.ascii_custom_row_widget.setVisible(is_custom)
        self._mark_halftone_dirty()
        self._on_control_changed()

    def _on_ascii_enabled_changed(self):
        """Handle ASCII mode enable/disable - disable regular halftone controls when ASCII is active"""
        enabled = self.ascii_enabled_chk.isChecked()
        # Update status bar
        if enabled:
            self.statusBar().showMessage("ascii art mode enabled - halftone patterns replaced with characters")
        else:
            self.statusBar().showMessage("ready")

    def _get_ascii_charset(self, charset_name: str, custom_chars: str = "") -> str:
        """Get the character set for ASCII art rendering (light to dark)"""
        charsets = {
            "default": " .:-=+*#%@",
            "slashes": " ....----////\\\\\\\\####",
            "emoticons": "   :) :| :( :D ;) :P >:(",
            "symbols": " ·-~=<>(){}[]#@",
            "blocks": "  ░░▒▒▓▓██",  # Duplicated for smoother transitions (10 levels)
            "dots": " ·∘○◦•●",
            "geometric": " ·△▽○□◇◆▲▼█",
            "brackets": " ...((())){{{}}}[[[]]]###",
            "waves": " ~-≈≋∿",
            "custom": custom_chars if custom_chars.strip() else " .:-=+*#%@"
        }
        return charsets.get(charset_name, charsets["default"])

    def _render_ascii_art(self, arr: np.ndarray, p: 'Params') -> Image.Image:
        """Render array as ASCII art image (raster) for preview and PNG/TIFF export"""
        from PIL import ImageFont
        
        h, w = arr.shape
        cell_size = int(p.ascii_cell_size)
        font_size = int(p.ascii_font_size)
        
        # Get character set
        charset = self._get_ascii_charset(p.ascii_charset, p.ascii_custom_chars)
        num_chars = len(charset)
        if num_chars == 0:
            charset = " .:-=+*#%@"
            num_chars = len(charset)
        
        # Calculate grid dimensions
        cols = max(1, w // cell_size)
        rows = max(1, h // cell_size)
        
        # Downsample array to get average values per cell
        # Keep float precision during resize (don't convert to uint8 first)
        arr_float = arr.astype(np.float32)
        arr_pil = Image.fromarray(arr_float, mode='F')
        arr_resized = np.array(arr_pil.resize((cols, rows), Image.Resampling.LANCZOS))
        
        # Apply gamma correction to preserve mid-tone and highlight detail (like halftone mode)
        gamma = 1.8
        arr_resized = np.power(np.clip(arr_resized, 0.0, 1.0), 1.0 / gamma)
        
        # Invert if needed
        if p.ascii_invert:
            arr_resized = 1.0 - arr_resized
        
        # Create output image with transparency
        line_spacing = p.ascii_line_spacing
        out_h = int(rows * cell_size * line_spacing)
        out_w = cols * cell_size
        out = Image.new("RGBA", (out_w, out_h), (255, 255, 255, 0))
        dr = ImageDraw.Draw(out)
        
        # Try to load a monospace font
        font = None
        font_paths = ["consola.ttf", "cour.ttf", "DejaVuSansMono.ttf", "LiberationMono-Regular.ttf"]
        for font_path in font_paths:
            try:
                font = ImageFont.truetype(font_path, font_size)
                break
            except:
                continue
        if font is None:
            try:
                font = ImageFont.load_default()
            except:
                pass
        
        # Use threshold levels for quantization - auto-adjust if charset is smaller
        num_levels = max(2, min(p.ascii_threshold_levels, num_chars))
        
        # Render characters
        for row_idx in range(rows):
            for col_idx in range(cols):
                # Get the grayscale value (0 = white/light, 1 = black/dark)
                val = arr_resized[row_idx, col_idx]
                
                # Direct mapping from value to character index (avoid double quantization)
                # When threshold_levels <= num_chars, quantize to levels first for intentional posterization
                # Otherwise, map directly to characters for maximum detail
                if p.ascii_threshold_levels <= num_chars:
                    # User wants explicit threshold levels - quantize then map 1:1
                    level = int(val * (num_levels - 1) + 0.5)  # Round instead of truncate
                    level = max(0, min(num_levels - 1, level))
                    char_idx = int(level * (num_chars - 1) / max(1, num_levels - 1) + 0.5)
                else:
                    # More threshold levels than chars - map directly to chars for max detail
                    char_idx = int(val * (num_chars - 1) + 0.5)  # Round instead of truncate
                char_idx = max(0, min(num_chars - 1, char_idx))
                
                char = charset[char_idx]
                
                # Skip spaces (transparent)
                if char.strip() == "":
                    continue
                
                # Calculate position
                x = col_idx * cell_size
                y = int(row_idx * cell_size * line_spacing)
                
                # Draw character in black
                if font:
                    dr.text((x, y), char, fill=(0, 0, 0, 255), font=font)
                else:
                    dr.text((x, y), char, fill=(0, 0, 0, 255))
        
        # Resize to match original dimensions
        if out.size != (w, h):
            out = out.resize((w, h), Image.Resampling.LANCZOS)
        
        return out

    # Cache for glyph paths to avoid repeated font parsing
    _glyph_path_cache: Dict[str, Dict[str, str]] = {}
    
    def _get_glyph_svg_path(self, char: str, font_path: Optional[str] = None) -> Optional[str]:
        """Get SVG path data for a character glyph using fonttools"""
        if not HAS_FONTTOOLS:
            return None
        
        # Try to find a suitable font
        if font_path is None:
            font_paths = [
                "C:/Windows/Fonts/consola.ttf",
                "C:/Windows/Fonts/cour.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
                "/System/Library/Fonts/Courier.dfont"
            ]
            for fp in font_paths:
                if os.path.exists(fp):
                    font_path = fp
                    break
        
        if not font_path or not os.path.exists(font_path):
            return None
        
        # Check cache
        cache_key = font_path
        if cache_key not in self._glyph_path_cache:
            self._glyph_path_cache[cache_key] = {}
        
        if char in self._glyph_path_cache[cache_key]:
            return self._glyph_path_cache[cache_key][char]
        
        try:
            if not HAS_FONTTOOLS or TTFont is None or SVGPathPen is None:
                return None
            assert TTFont is not None and SVGPathPen is not None
            font = TTFont(font_path)
            glyph_set = font.getGlyphSet()
            cmap = font.getBestCmap()
            
            if cmap is None or ord(char) not in cmap:
                return None
            
            glyph_name = cmap[ord(char)]
            pen = SVGPathPen(glyph_set)
            glyph_set[glyph_name].draw(pen)
            path_data = pen.getCommands()
            
            # Cache the result
            self._glyph_path_cache[cache_key][char] = path_data
            font.close()
            
            return path_data
        except Exception as e:
            return None

    def _update_titles(self):
        w_in, h_in = self._get_doc_size_in(self._doc_orientation)
        dpi = self._working_dpi()
        self.setWindowTitle(f"halftone_glitch_v2 — {w_in}×{h_in} in @{dpi} dpi • cmyk + fx")
        if hasattr(self, '_artboard_info_label'):
            self._artboard_info_label.setText(f"{w_in}×{h_in} in  •  {dpi} dpi  •  {self._doc_orientation}")
            self._artboard_info_label.adjustSize()
            self._reposition_overlays()

    def _on_artboard_changed(self, *_):
        self._art_cache.clear(); self._cmyk_cache.clear(); self._arr_cache.clear()
        self._mark_halftone_dirty(); self._update_titles()
        self._on_control_changed()

    def _toggle_bg_color(self):
        self._bg_black = not self._bg_black
        self._update_bg_color_box()
        self._layer_render_cache.clear()
        self._preview_cache.clear()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _update_bg_color_box(self):
        """Update the bg color indicator box style and reposition overlays."""
        c = "#000000" if self._bg_black else "#ffffff"
        border = "#888"
        self._bg_color_box.setStyleSheet(
            f"background:{c};border:2px solid {border};border-radius:4px;min-width:0;padding:0;")
        self._reposition_overlays()

    def _reposition_overlays(self):
        """Reposition all overlay widgets (bg color box, artboard info) on the preview."""
        parent = self._bg_color_box.parentWidget()
        if parent:
            self._bg_color_box.move(6, parent.height() - self._bg_color_box.height() - 6)
            if hasattr(self, '_artboard_info_label'):
                lbl = self._artboard_info_label
                lbl.move(parent.width() - lbl.width() - 6,
                         parent.height() - lbl.height() - 6)

    def _bg_rgba(self) -> Tuple[int, int, int, int]:
        """Return the current artboard background color as RGBA tuple."""
        return (0, 0, 0, 255) if self._bg_black else (255, 255, 255, 255)

    def _reg_mark_color(self) -> Tuple[int, int, int, int]:
        """Return registration mark color — white on black bg, black on white bg."""
        return (255, 255, 255, 255) if self._bg_black else (0, 0, 0, 255)

    def _reg_mark_hex(self) -> str:
        """Return registration mark color as hex string for SVG."""
        return "#ffffff" if self._bg_black else "#000000"

    def _clear_sprite_caches(self):
        self._rotated_sprite_cache.clear(); self._mask_cache.clear()

    def _refresh_gray_ui(self):
        gray = self.gray_chk.isChecked()
        for w in (self.full_comp, self.preview_chan):
            w.setEnabled(not gray)
        for ch in 'cmy':
            self.disp_sliders[ch][0].setEnabled(not gray)
            self.disp_sliders[ch][1].setEnabled(not gray)

    def _apply_preset(self, text: str):
        if not text: return
        vals = self.PRESETS.get(text)
        if not vals: return
        try:
            c_ang, m_ang, y_ang, k_ang = vals
            self.ang_c.setValue(int(c_ang))
            self.ang_m.setValue(int(m_ang))
            self.ang_y.setValue(int(y_ang))
            self.ang_k.setValue(int(k_ang))
        except Exception:
            return
        self._mark_halftone_dirty()
        self._on_control_changed()
        self._schedule_moire_update()

    def _shape_id(self) -> str:
        m = self.mode.currentText()
        if m == "dot": return "circle"
        if m == "custom" and self.shape_paths is not None: return "custom"
        return m

    def _make_base_sprite(self, shape: str, size: int = 96) -> Image.Image:
        key = f"{shape}-{size}"
        if key in self._sprite_cache: return self._sprite_cache[key]
        img = Image.new("L", (size, size), 0); d = ImageDraw.Draw(img)
        if shape in ("circle", "dot"): d.ellipse((0,0,size-1,size-1), fill=255)
        elif shape == "square": d.rectangle((0,0,size-1,size-1), fill=255)
        elif shape == "triangle": d.polygon([(size/2,0),(size-1,size-1),(0,size-1)], fill=255)
        elif shape == "cross":
            t = max(1, int(size*0.28)); c = size//2
            d.rectangle((c-t//2,0,c+t//2,size-1), fill=255)
            d.rectangle((0,c-t//2,size-1,c+t//2), fill=255)
        elif shape == "diamond":
            d.polygon([(size/2,0),(size-1,size/2),(size/2,size-1),(0,size/2)], fill=255)
        elif shape == "circle outline":
            pass
        elif shape == "custom" and self.shape_paths is not None and self.shape_bbox is not None:
            img = self._rasterize_svg_paths(self.shape_paths, self.shape_bbox, out_size=96)
        else:
            d.ellipse((0,0,size-1,size-1), fill=255)
        self._sprite_cache[key] = img; return img

    def _get_rotated_mask(self, shape: str, angle_deg: int, d: int, p: Optional[Params]) -> Image.Image:
        rot_key = (shape, 96, angle_deg if self.rotate_shape else -999)
        base_rot = self._rotated_sprite_cache.get(rot_key)
        if base_rot is None:
            if shape != "circle outline":
                base = self._make_base_sprite(shape, 96)
                base_rot = base.rotate(angle_deg, resample=Image.Resampling.BICUBIC, expand=True) if self.rotate_shape else base
            else:
                base_rot = Image.new("L", (96, 96), 0)
            self._rotated_sprite_cache[rot_key] = base_rot

        ring_t = 0
        if shape == "circle outline" and p is not None:
            ring_t = max(1, int(round(p.stroke)))
        mask_key = (shape, angle_deg if self.rotate_shape else -999, d, ring_t)
        mask = self._mask_cache.get(mask_key)
        if mask is None:
            if shape == "circle outline":
                sz = max(1, d); m = Image.new("L", (sz, sz), 0); dr = ImageDraw.Draw(m)
                dr.ellipse((0,0,sz-1,sz-1), fill=255)
                inner = max(0, sz - 2*ring_t)
                if inner > 0:
                    pad = (sz - inner)//2; dr.ellipse((pad, pad, pad+inner-1, pad+inner-1), fill=0)
                mask = m
            else:
                mask = base_rot.resize((d, d), Image.Resampling.LANCZOS)
            self._mask_cache[mask_key] = mask
        return mask

    def _rasterize_svg_paths(self, paths: List, bbox: Tuple[float,float,float,float], out_size: int = 96) -> Image.Image:
        minx, miny, maxx, maxy = bbox
        w = max(1.0, maxx - minx); h = max(1.0, maxy - miny)
        scale = min(out_size / w, out_size / h); ox = -minx; oy = -miny
        img = Image.new("L", (out_size, out_size), 0); drw = ImageDraw.Draw(img)
        for path in paths:
            N = 600; pts = [path.point(i/(N-1)) for i in range(N)]
            xy = [((float(p.real)+ox)*scale, (float(p.imag)+oy)*scale) for p in pts]
            if len(xy) >= 3: drw.polygon(xy, fill=255)
        return img

    def _get_doc_size_in(self, orientation: Optional[str] = None) -> Tuple[float, float]:
        if orientation is None: orientation = self._doc_orientation
        w_in, h_in = self._doc_width_in, self._doc_height_in
        return (w_in, h_in) if orientation == "portrait" else (h_in, w_in)

    def _get_transform(self) -> Transform:
        # Top "scale" control is per-layer (Layer.scale_pct), not a global transform.
        return Transform(100, int(self._offset_x), int(self._offset_y), self._doc_orientation)

    def _working_dpi(self) -> int:
        """Return the current working DPI (set at startup or from loaded project)."""
        return self._doc_dpi

    def _upscale_for_export(self, img: Image.Image) -> Image.Image:
        """Upscale image from working DPI to 240 DPI using nearest-neighbour."""
        wdpi = self._working_dpi()
        if wdpi >= DOC_DPI:
            return img
        scale = DOC_DPI / wdpi
        new_w = int(round(img.width * scale))
        new_h = int(round(img.height * scale))
        return img.resize((new_w, new_h), Image.Resampling.NEAREST)

    def _artboard_size_px_from_transform(self, tr: Optional[Transform] = None) -> Tuple[int, int]:
        if tr is None: tr = self._get_transform()
        w_in, h_in = self._get_doc_size_in(tr.orientation)
        dpi = self._working_dpi()
        return (int(round(w_in*dpi)), int(round(h_in*dpi)))

    def _get_processed_source_image(self, p: Optional[Params] = None) -> Optional[Image.Image]:
        """Return source image after global preprocessing shared by all render paths."""
        if self.img_full_rgba is None:
            return None

        # Pixelate is a global source-stage override: pixelate once, then all
        # downstream features (including per-layer/accordion effects) run on it.
        if hasattr(self, 'pixelate_enabled_chk') and self.pixelate_enabled_chk.isChecked():
            src = self.img_full_rgba
            block = 20
            if hasattr(self, 'pixelate_block_s'):
                block = max(2, int(self.pixelate_block_s.value()))

            if block <= 1:
                return src

            w, h = src.size
            rows = np.arange(0, h, block)
            cols = np.arange(0, w, block)

            rgba = np.asarray(src, dtype=np.float32)

            def _block_avg(ch: np.ndarray) -> np.ndarray:
                s = np.add.reduceat(ch, rows, axis=0)
                s = np.add.reduceat(s, cols, axis=1)
                bh = np.diff(np.append(rows, h)).reshape(-1, 1)
                bw = np.diff(np.append(cols, w)).reshape(1, -1)
                return s / (bh * bw)

            r_blk = _block_avg(rgba[:, :, 0])
            g_blk = _block_avg(rgba[:, :, 1])
            b_blk = _block_avg(rgba[:, :, 2])
            a_blk = _block_avg(rgba[:, :, 3])

            bh_sizes = np.diff(np.append(rows, h))
            bw_sizes = np.diff(np.append(cols, w))

            r_full = np.repeat(np.repeat(r_blk, bh_sizes, axis=0), bw_sizes, axis=1)
            g_full = np.repeat(np.repeat(g_blk, bh_sizes, axis=0), bw_sizes, axis=1)
            b_full = np.repeat(np.repeat(b_blk, bh_sizes, axis=0), bw_sizes, axis=1)
            a_full = np.repeat(np.repeat(a_blk, bh_sizes, axis=0), bw_sizes, axis=1)

            pix = np.dstack([
                np.clip(r_full, 0, 255).astype(np.uint8),
                np.clip(g_full, 0, 255).astype(np.uint8),
                np.clip(b_full, 0, 255).astype(np.uint8),
                np.clip(a_full, 0, 255).astype(np.uint8),
            ])
            return Image.fromarray(pix, mode="RGBA")

        return self.img_full_rgba

    def _compose_on_artboard(self, src_rgba: Image.Image, tr: Transform, transparent_bg: bool = False) -> Image.Image:
        W, H = self._artboard_size_px_from_transform(tr)
        bg = (0, 0, 0, 0) if transparent_bg else self._bg_rgba()
        canvas = Image.new("RGBA", (W, H), bg)
        if src_rgba is None: return canvas
        s = max(0.01, tr.scale_pct / 100.0)
        sw, sh = src_rgba.size
        tw, th = max(1, int(sw*s)), max(1, int(sh*s))
        img = src_rgba.resize((tw, th), Image.Resampling.LANCZOS)
        # Subtract offset for viewport panning (image stays fixed, viewport moves)
        ox = (W - img.width)//2 - tr.offset_x_px
        oy = (H - img.height)//2 - tr.offset_y_px
        canvas.alpha_composite(img, dest=(ox, oy))
        return canvas

    def _compose_on_artboard_scaled_preview(self, tr: Transform, scale: float) -> Image.Image:
        W, H = self._artboard_size_px_from_transform(tr)
        if not Image:
            return Image.new("RGBA", (W, H), self._bg_rgba())
        # Always return a full-size artboard so the preview never looks like a thumbnail.
        W, H = self._artboard_size_px_from_transform(tr)
        canvas = Image.new("RGBA", (W, H), self._bg_rgba())
        
        # Use processed source image with channel flipping (no params to avoid circular dependency)
        processed_img = self._get_processed_source_image(None)
        if processed_img is None: 
            return canvas

        # Compute full-resolution placement geometry
        img_scale = max(0.01, tr.scale_pct / 100.0)
        sw, sh = processed_img.size
        tw_full, th_full = max(1, int(sw * img_scale)), max(1, int(sh * img_scale))

        # Render content at reduced resolution, then upscale back to full placement size
        try:
            # Ensure scale is within safe bounds
            scale = max(0.02, min(scale, 1.0))  # Prevent extreme values
            
            tw_small, th_small = max(1, int(tw_full * scale)), max(1, int(th_full * scale))
            # Ultra-fast resampling for extreme scales - prioritize speed over quality
            if scale < 0.08:
                # For very low scales (interaction), use fastest possible method
                resample_method = Image.Resampling.NEAREST
            elif scale < 0.2:
                # For low scales, still prioritize speed
                resample_method = Image.Resampling.NEAREST  # Changed from BILINEAR for speed
            else:
                # For reasonable scales, use good quality
                resample_method = Image.Resampling.BILINEAR  # Changed from LANCZOS for speed
                
            down = processed_img.resize((tw_small, th_small), resample_method)
            # Always use NEAREST for upscaling during interaction for maximum speed
            img = down.resize((tw_full, th_full), Image.Resampling.NEAREST)

            # Use the same offset calculation as _compose_on_artboard for consistency
            # Subtract offset for viewport panning (image stays fixed, viewport moves)
            ox = (W - tw_full) // 2 - tr.offset_x_px
            oy = (H - th_full) // 2 - tr.offset_y_px

            # Clamp composition inside the canvas
            ox = max(-img.width + 1, min(W, ox))
            oy = max(-img.height + 1, min(H, oy))

            canvas.alpha_composite(img, dest=(ox, oy))
        except Exception as e:
            print(f"Error in scaled preview: {e}")

        return canvas

    def _art_key(self, tr: Transform) -> Tuple:
        layer_key = tuple((id(l.image), l.visible, l.offset_x, l.offset_y, l.scale_pct, l.opacity) for l in self._layers) if self._layers else (id(self.img_full_rgba),)
        pixelate_enabled = bool(hasattr(self, 'pixelate_enabled_chk') and self.pixelate_enabled_chk.isChecked())
        pixelate_block = int(self.pixelate_block_s.value()) if hasattr(self, 'pixelate_block_s') else 20
        return (
            layer_key,
            self.art_size.currentText(),
            tr.orientation,
            tr.scale_pct,
            tr.offset_x_px,
            tr.offset_y_px,
            pixelate_enabled,
            pixelate_block,
        )

    def _artboard_rgba_cached(self, tr: Transform) -> Image.Image:
        if self.img_full_rgba is None:
            W, H = self._artboard_size_px_from_transform(tr)
            return Image.new("RGBA", (W, H), self._bg_rgba())
        key = self._art_key(tr)
        art = self._art_cache.get(key)
        if art is None:
            # Use processed source image with channel flipping (no params to avoid circular dependency)
            processed_img = self._get_processed_source_image(None)
            if processed_img is not None:
                art = self._compose_on_artboard(processed_img, tr)
            else:
                art = self._compose_on_artboard(self.img_full_rgba, tr)
            self._art_cache[key] = art
        return art

    def _artboard_rgba_transparent(self, tr: Transform) -> Image.Image:
        """Compose source onto a transparent artboard (for stereogram alpha preservation)."""
        processed_img = self._get_processed_source_image(None)
        src = processed_img if processed_img is not None else self.img_full_rgba
        if src is None:
            W, H = self._artboard_size_px_from_transform(tr)
            return Image.new("RGBA", (W, H), (0, 0, 0, 0))
        return self._compose_on_artboard(src, tr, transparent_bg=True)

    def _base_cmyk_cached(self, art_key: Tuple, art_rgba: Image.Image) -> Image.Image:
        im = self._cmyk_cache.get(art_key)
        if im is None:
            im = rgba_to_cmyk_with_icc(art_rgba, self.cmyk_icc_path)
            self._cmyk_cache[art_key] = im
        return im

    def _fast_array_processing(self, arr: np.ndarray, operation: str, **kwargs) -> np.ndarray:
        """High-performance array processing with GPU acceleration when available"""
        try:
            if HAS_CUPY and cp is not None and arr.size > 100_000:  # Use GPU for large arrays
                gpu_arr = cp.asarray(arr)
                if operation == "invert":
                    threshold = kwargs.get('threshold', 0.015)
                    mask = gpu_arr > threshold
                    result = cp.where(mask, 1.0 - gpu_arr, gpu_arr)
                elif operation == "gamma":
                    gamma = kwargs.get('gamma', 1.0)
                    result = cp.clip(gpu_arr, 0.0, 1.0) ** gamma
                elif operation == "threshold":
                    threshold = kwargs.get('threshold', 0.5)
                    result = (gpu_arr > threshold).astype(cp.float32)
                elif operation == "threshold_map":
                    threshold_map = kwargs.get('threshold_map')
                    if threshold_map is not None:
                        gpu_threshold_map = cp.asarray(threshold_map)
                        result = (gpu_arr > gpu_threshold_map).astype(cp.float32)
                    else:
                        result = gpu_arr
                else:
                    result = gpu_arr
                return cp.asnumpy(result)
            else:
                # CPU processing with NumPy optimizations
                if operation == "invert":
                    threshold = kwargs.get('threshold', 0.015)
                    mask = arr > threshold
                    return np.where(mask, 1.0 - arr, arr)
                elif operation == "gamma":
                    gamma = kwargs.get('gamma', 1.0)
                    return np.clip(arr, 0.0, 1.0) ** gamma
                elif operation == "threshold":
                    threshold = kwargs.get('threshold', 0.5)
                    return (arr > threshold).astype(np.float32)
                elif operation == "threshold_map":
                    threshold_map = kwargs.get('threshold_map')
                    if threshold_map is not None:
                        return (arr > threshold_map).astype(np.float32)
                    else:
                        return arr
                else:
                    return arr
        except Exception:
            # Fallback to basic NumPy processing
            if operation == "invert":
                threshold = kwargs.get('threshold', 0.015)
                mask = arr > threshold
                return np.where(mask, 1.0 - arr, arr)
            elif operation == "gamma":
                gamma = kwargs.get('gamma', 1.0)
                return np.clip(arr, 0.0, 1.0) ** gamma
            elif operation == "threshold_map":
                threshold_map = kwargs.get('threshold_map')
                if threshold_map is not None:
                    return (arr > threshold_map).astype(np.float32)
                else:
                    return arr
            else:
                return arr
    
    def _optimize_image_processing(self, image: Image.Image, max_dimension: int = 2048) -> Image.Image:
        """Optimize image processing by scaling down very large images for better performance"""
        w, h = image.size
        
        # Only scale down if both dimensions exceed the maximum
        if w > max_dimension and h > max_dimension:
            # Calculate scale factor to keep the largest dimension at max_dimension
            scale = max_dimension / max(w, h)
            new_w, new_h = int(w * scale), int(h * scale)
            
            # Use high-quality resampling for downscaling
            if HAS_OPENCV and cv2 is not None:
                # OpenCV is fastest for large image scaling
                img_array = np.array(image)
                resized_array = cv2.resize(img_array, (new_w, new_h), interpolation=cv2.INTER_AREA)
                return Image.fromarray(resized_array)
            else:
                # Fallback to PIL
                return image.resize((new_w, new_h), Image.Resampling.LANCZOS)
        
        return image
    
    def _gamma_from_contrast(self, pct: float) -> float:
        pct = max(1.0, float(pct))
        return 100.0 / pct

    def _arr_gray_cached(self, tr: Transform, invert: bool) -> np.ndarray:
        key = (self._art_key(tr), 'grayK', bool(invert), 100)
        arr = self._arr_cache.get(key)
        if arr is None:
            art_trans = self._artboard_rgba_transparent(tr)
            L = art_trans.convert("L")
            A = art_trans.getchannel("A")
            aL = np.asarray(L, dtype=np.float32) / 255.0
            aA = np.asarray(A, dtype=np.float32) / 255.0
            cov = (1.0 - aL) if not invert else aL
            # Preserve existing B/W tonal behaviour while honoring source-stage pixelation.
            bw_gamma = 0.75
            cov = (np.clip(cov, 0.0, 1.0) ** bw_gamma) * aA
            self._arr_cache[key] = cov
            arr = cov
        return arr

    def _arr_cmyk_cached(self, art_key: Tuple, art_rgba: Image.Image, channel: str, invert: bool = False) -> np.ndarray:
        key = (art_key, 'cmyk', channel, 100, invert)
        arr = self._arr_cache.get(key)
        if arr is None:
            base_cmyk = self._base_cmyk_cached(art_key, art_rgba)
            c, m, y, k = base_cmyk.split()
            chan = {"c": c, "m": m, "y": y, "k": k}[channel]
            a = np.asarray(chan, dtype=np.float32) / 255.0
            alpha = np.asarray(art_rgba.getchannel("A"), dtype=np.float32) / 255.0
            
            # Apply invert efficiently using fast array processing
            if invert:
                a = self._fast_array_processing(a, "invert", threshold=0.015)
                
            # Apply gamma correction with fast processing
            gamma = self._gamma_from_contrast(100)
            a = self._fast_array_processing(a, "gamma", gamma=gamma)
            a = (a * alpha).astype(np.float32)
            self._arr_cache[key] = a; arr = a
        return arr

    def fit_image_to_artboard(self):
        idx = self._selected_layer_idx
        if idx < 0 or idx >= len(self._layers):
            return
        layer = self._layers[idx]
        tr = self._get_transform()
        W, H = self._artboard_size_px_from_transform(tr)
        sw, sh = layer.image.size
        if sw == 0 or sh == 0: return
        s = max(0.01, min(W/sw, H/sh)) * 100.0
        layer.scale_pct = int(round(s))
        self.scale_s.blockSignals(True); self.scale_s.setValue(int(round(s))); self.scale_s.blockSignals(False)
        if hasattr(self, 'scale_input'):
            self.scale_input.blockSignals(True); self.scale_input.setText(str(int(round(s)))); self.scale_input.blockSignals(False)
        layer.offset_x = 0
        layer.offset_y = 0
        self._rebuild_composite()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def fit_view_to_window(self):
        if not self._prev_pix or self.prev_lbl is None: return
        pm_w, pm_h = self._prev_pix.width(), self._prev_pix.height()
        vw, vh = max(1, self.prev_lbl.width()), max(1, self.prev_lbl.height())
        z = int(max(10, min(400, math.floor(min(vw/pm_w, vh/pm_h) * 100))))
        self.zoom.blockSignals(True); self.zoom.setValue(z); self.zoom.blockSignals(False)
        self.prev_lbl.set_zoom(z/100.0)
        self._update_scrollbar_ranges()

    def on_drag_delta(self, dx_widget: int, dy_widget: int) -> None:
        if self.prev_lbl is None:
            return
        z = max(0.01, float(self.prev_lbl.zoom_scale))
        scale_factor = z
        dx_art = int(round(dx_widget / scale_factor))
        dy_art = int(round(dy_widget / scale_factor))
        # If a layer is selected, move that layer; otherwise pan viewport
        idx = self._selected_layer_idx
        if idx >= 0 and idx < len(self._layers):
            self._layers[idx].offset_x += dx_art
            self._layers[idx].offset_y += dy_art
            self._rebuild_composite()
            self._mark_halftone_dirty()
            self._render_timer.start(16)
        else:
            self.prev_lbl._view_pan_x += dx_widget
            self.prev_lbl._view_pan_y += dy_widget
            self.prev_lbl.update()
            self._update_scrollbar_ranges()

    def center_offsets(self):
        """Center selected layer (or viewport if no layer selected)."""
        idx = self._selected_layer_idx
        if 0 <= idx < len(self._layers):
            self._layers[idx].offset_x = 0
            self._layers[idx].offset_y = 0
            self._rebuild_composite()
        else:
            self._offset_x = 0
            self._offset_y = 0
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _sync_scale_ui_to_selected_layer(self):
        """Keep the top scale controls in sync with the currently selected layer."""
        idx = self._selected_layer_idx
        v = 100
        if 0 <= idx < len(self._layers):
            v = int(max(self.scale_s.minimum(), min(self.scale_s.maximum(), self._layers[idx].scale_pct)))
        self.scale_s.blockSignals(True)
        self.scale_s.setValue(v)
        self.scale_s.blockSignals(False)
        if hasattr(self, 'scale_input'):
            self.scale_input.blockSignals(True)
            self.scale_input.setText(str(v))
            self.scale_input.blockSignals(False)

    def _mark_halftone_dirty(self): self._halftone_dirty = True

    # ---- LAYER MANAGEMENT ----

    def _sync_layer_list_widget(self):
        """Rebuild the QListWidget from self._layers."""
        self.layer_list.blockSignals(True)
        self.layer_list.clear()
        for i, lay in enumerate(self._layers):
            vis = "\U0001f441 " if lay.visible else "\u2014 "
            lock = "\U0001f512 " if lay.locked else ""
            fx = "\u2728" if lay.effect_params is not None else ""
            self.layer_list.addItem(f"{vis}{lock}{fx}{lay.name}")
        if 0 <= self._selected_layer_idx < len(self._layers):
            self.layer_list.setCurrentRow(self._selected_layer_idx)
            self._sync_scale_ui_to_selected_layer()
            # Update lock button icon
            if self._layers[self._selected_layer_idx].locked:
                self._layer_lock_btn.setText("\U0001f512")
            else:
                self._layer_lock_btn.setText("\U0001f513")
        self.layer_list.blockSignals(False)

    def _deferred_sync_layer_list(self):
        """Debounced layer list rebuild — called from QTimer to avoid thrashing during slider drags."""
        if self._layer_list_dirty:
            self._layer_list_dirty = False
            self._sync_layer_list_widget()

    def _add_layer(self, img: Image.Image, name: str):
        # Save current params to the previously selected layer before switching
        old_idx = self._selected_layer_idx
        if 0 <= old_idx < len(self._layers) and not self._layers[old_idx].locked:
            self._layers[old_idx].effect_params = self.params()
        lay = Layer(name=name, image=img.convert("RGBA"))
        # Initialize the new layer with fresh default params
        lay.effect_params = self._default_params()
        self._layers.append(lay)
        self._selected_layer_idx = len(self._layers) - 1
        self._sync_scale_ui_to_selected_layer()
        # Rebuild composite FIRST so img_full_rgba is up-to-date before any preview
        self._rebuild_composite()
        # Apply the new layer's default params to the UI (may trigger preview)
        self._apply_params_to_ui(lay.effect_params)
        self._sync_layer_list_widget()

    def _rebuild_composite(self):
        """Flatten visible layers into self.img_full_rgba for the render pipeline."""
        if not self._layers:
            self.img_full_rgba = None
            return
        # Use first visible layer to determine base size
        first_vis = next((l for l in self._layers if l.visible), None)
        if first_vis is None:
            self.img_full_rgba = None
            return
        # Composite all visible layers
        base_w, base_h = first_vis.image.size
        comp = Image.new("RGBA", (base_w, base_h), (0, 0, 0, 0))
        for lay in self._layers:
            if not lay.visible:
                continue
            limg = lay.image
            s = max(0.01, lay.scale_pct / 100.0)
            sw, sh = limg.size
            tw, th = max(1, int(sw * s)), max(1, int(sh * s))
            if (tw, th) != (sw, sh):
                limg = limg.resize((tw, th), Image.Resampling.LANCZOS)
            # Place layer at its offset relative to center of base
            ox = (base_w - tw) // 2 + lay.offset_x
            oy = (base_h - th) // 2 + lay.offset_y
            if lay.opacity < 1.0:
                limg = limg.copy()
                alpha = limg.getchannel("A")
                alpha = alpha.point(lambda a: int(a * lay.opacity))
                limg.putalpha(alpha)
            tmp = Image.new("RGBA", (base_w, base_h), (0, 0, 0, 0))
            tmp.paste(limg, (ox, oy))
            comp = Image.alpha_composite(comp, tmp)
        self.img_full_rgba = comp
        self._art_cache.clear()
        self._cmyk_cache.clear()
        self._arr_cache.clear()
        self._layer_render_cache.clear()
        self._content_alpha_cache_key = None
        self._content_alpha_cache_img = None

    def _apply_params_to_ui(self, p: 'Params'):
        """Set all UI controls from a Params object without triggering cascading updates."""
        self._restoring_params = True
        try:
            self.mode.setCurrentText(p.mode)
            self.cell_s.setValue(int(p.cell * 100))
            self.str_s.setValue(int(p.stroke * 100))
            self.preview_chan.setCurrentText(p.preview_channel)
            self.ang_c.setValue(int(p.ang_c))
            self.ang_m.setValue(int(p.ang_m))
            self.ang_y.setValue(int(p.ang_y))
            self.ang_k.setValue(int(p.ang_k))
            self.full_comp.setChecked(p.full_composite_preview)
            # Registration controls are composition-level (owned by Background layer)
            # — do NOT overwrite them when switching between layers
            # self.regs_chk.setChecked(p.regs_on)
            # self.reg_size_s.setValue(int(p.reg_size_px))
            # self.reg_offset_s.setValue(int(p.reg_offset_px))
            self.gray_chk.setChecked(p.grayscale_mode)
            # Invert: set the halftone invert checkbox (primary), clear others
            if hasattr(self, 'halftone_invert_chk'):
                self.halftone_invert_chk.setChecked(p.invert_gray)
            if hasattr(self, 'glitch_invert_chk'):
                self.glitch_invert_chk.setChecked(False)
            if hasattr(self, 'diffusion_invert_chk'):
                self.diffusion_invert_chk.setChecked(False)
            self.warp_amt_s.setValue(int(p.warp_amt * 10))
            self.warp_scale_s.setValue(int(p.warp_scale * 100))
            self.slice_shift_s.setValue(p.slice_shift_amt)
            self.vertical_slice_shift_s.setValue(p.vertical_slice_shift_amt)
            if hasattr(self, 'slice_size_s'):
                self.slice_size_s.setValue(getattr(p, 'slice_size_px', 20))
            if hasattr(self, 'slice_angle_s'):
                self.slice_angle_s.setValue(int(getattr(p, 'slice_angle', 0.0)))
            if hasattr(self, 'vertical_slice_size_s'):
                self.vertical_slice_size_s.setValue(getattr(p, 'vertical_slice_size_px', 20))
            if hasattr(self, 'vertical_slice_angle_s'):
                self.vertical_slice_angle_s.setValue(int(getattr(p, 'vertical_slice_angle', 0.0)))
            self.ht_slice_s.setValue(p.halftone_slice_shift_amt)
            self.ht_vslice_s.setValue(p.halftone_vertical_slice_shift_amt)
            # Displacement sliders
            for ch in 'cmyk':
                dx, dy = getattr(p, f'displace_{ch}')
                self.disp_sliders[ch][0].setValue(dx)
                self.disp_sliders[ch][1].setValue(dy)
            # Diffusion parameters
            if hasattr(self, 'diffusion_enabled_chk'):
                self.diffusion_enabled_chk.setChecked(p.diffusion_enabled)
            if hasattr(self, 'diffusion_algo_combo'):
                self.diffusion_algo_combo.setCurrentText(p.diffusion_algorithm)
            if hasattr(self, 'diffusion_intensity_s'):
                self.diffusion_intensity_s.setValue(int(p.diffusion_intensity * 100))
            if hasattr(self, 'diffusion_levels_s'):
                self.diffusion_levels_s.setValue(p.diffusion_levels)
            if hasattr(self, 'diffusion_sharpen_s'):
                self.diffusion_sharpen_s.setValue(int(p.diffusion_sharpen_strength * 100))
            if hasattr(self, 'diffusion_radius_s'):
                self.diffusion_radius_s.setValue(int(p.diffusion_sharpen_radius))
            if hasattr(self, 'diffusion_denoise_s'):
                self.diffusion_denoise_s.setValue(int(p.diffusion_denoise * 100))
            if hasattr(self, 'diffusion_mod_combo'):
                self.diffusion_mod_combo.setCurrentText(p.diffusion_modulation)
            if hasattr(self, 'diffusion_mod_strength_s'):
                self.diffusion_mod_strength_s.setValue(int(p.diffusion_mod_strength * 100))
            # Diffusion glitch effects
            if hasattr(self, 'broken_kernel_s'):
                self.broken_kernel_s.setValue(int(p.broken_kernel * 100))
            if hasattr(self, 'dir_bias_s'):
                self.dir_bias_s.setValue(int(p.directional_bias * 100))
            if hasattr(self, 'dir_bias_angle_s'):
                self.dir_bias_angle_s.setValue(int(p.directional_bias_angle))
            if hasattr(self, 'error_overflow_s'):
                self.error_overflow_s.setValue(int(p.error_overflow * 100))
            if hasattr(self, 'diffusion_reset_s'):
                self.diffusion_reset_s.setValue(int(p.diffusion_reset * 100))
            if hasattr(self, 'cross_bleed_s'):
                self.cross_bleed_s.setValue(int(p.cross_channel_bleed * 100))
            # Datamosh effects
            if hasattr(self, 'smear_drag_s'):
                self.smear_drag_s.setValue(int(p.smear_drag * 100))
            if hasattr(self, 'smear_length_s'):
                self.smear_length_s.setValue(p.smear_length)
            if hasattr(self, 'smear_vertical_chk'):
                self.smear_vertical_chk.setChecked(p.smear_vertical)
            if hasattr(self, 'macroblock_s'):
                self.macroblock_s.setValue(int(p.macroblock_corrupt * 100))
            if hasattr(self, 'macroblock_dropout_s'):
                self.macroblock_dropout_s.setValue(int(p.macroblock_dropout * 100))
            if hasattr(self, 'block_shift_s'):
                self.block_shift_s.setValue(int(p.block_shift * 100))
            if hasattr(self, 'block_size_s'):
                self.block_size_s.setValue(p.block_shift_size)
            if hasattr(self, 'chan_desync_s'):
                self.chan_desync_s.setValue(int(p.channel_desync * 100))
            if hasattr(self, 'bitmap_sort_s'):
                self.bitmap_sort_s.setValue(int(p.bitmap_sort * 100))
            if hasattr(self, 'bitmap_sort_vert_chk'):
                self.bitmap_sort_vert_chk.setChecked(p.bitmap_sort_vertical)
            # Lines control parameters
            if hasattr(self, 'line_length_s'):
                self.line_length_s.setValue(int(p.line_length_pct))
            if hasattr(self, 'line_width_s'):
                self.line_width_s.setValue(int(p.line_width_pct * 100))
            if hasattr(self, 'line_weight_s'):
                self.line_weight_s.setValue(int(p.line_weight_variation * 100))
            if hasattr(self, 'line_density_s'):
                self.line_density_s.setValue(int(p.line_density_pct * 100))
            if hasattr(self, 'line_taper_s'):
                self.line_taper_s.setValue(int(p.line_taper_pct * 100))
            if hasattr(self, 'stroke_random_s'):
                self.stroke_random_s.setValue(int(p.stroke_randomness * 100))
            if hasattr(self, 'lines_invert_chk'):
                self.lines_invert_chk.setChecked(p.hatching_invert)
            if hasattr(self, 'lines_use_flow_path_chk'):
                self.lines_use_flow_path_chk.setChecked(p.lines_use_flow_path)
            if hasattr(self, 'lines_path_influence_s'):
                self.lines_path_influence_s.setValue(int(p.lines_path_influence))
            # ASCII Art parameters
            if hasattr(self, 'ascii_enabled_chk'):
                self.ascii_enabled_chk.setChecked(p.ascii_enabled)
            if hasattr(self, 'ascii_charset_combo'):
                self.ascii_charset_combo.setCurrentText(p.ascii_charset)
            if hasattr(self, 'ascii_custom_input'):
                self.ascii_custom_input.setText(p.ascii_custom_chars)
            if hasattr(self, 'ascii_cell_size_s'):
                self.ascii_cell_size_s.setValue(int(p.ascii_cell_size))
            if hasattr(self, 'ascii_invert_chk'):
                self.ascii_invert_chk.setChecked(p.ascii_invert)
            if hasattr(self, 'ascii_threshold_s'):
                self.ascii_threshold_s.setValue(p.ascii_threshold_levels)
            if hasattr(self, 'ascii_font_size_s'):
                self.ascii_font_size_s.setValue(int(p.ascii_font_size))
            if hasattr(self, 'ascii_spacing_s'):
                self.ascii_spacing_s.setValue(int(p.ascii_line_spacing * 100))
            if hasattr(self, 'ascii_keep_text_chk'):
                self.ascii_keep_text_chk.setChecked(p.ascii_keep_text_editable)
            # CMYK Pixelate parameters
            if hasattr(self, 'pixelate_enabled_chk'):
                self.pixelate_enabled_chk.setChecked(p.pixelate_enabled)
            if hasattr(self, 'pixelate_block_s'):
                self.pixelate_block_s.setValue(p.pixelate_block_size)
                # Stereogram parameters (handled separately below)
        # Stereogram parameters
            if hasattr(self, 'stereo_mode_chk'):
                self.stereo_mode_chk.setChecked(p.stereogram_mode)
            if hasattr(self, 'stereo_depth_s'):
                self.stereo_depth_s.setValue(p.stereo_depth_intensity)
            if hasattr(self, 'stereo_sep_s'):
                self.stereo_sep_s.setValue(p.stereo_separation)
            if hasattr(self, 'stereo_smooth_s'):
                self.stereo_smooth_s.setValue(p.stereo_smooth_depth)
            if hasattr(self, 'stereo_invert_chk'):
                self.stereo_invert_chk.setChecked(p.stereo_invert_depth)
            if hasattr(self, 'stereo_dot_s'):
                self.stereo_dot_s.setValue(p.stereo_dot_size)
            if hasattr(self, 'stereo_fray_x_s'):
                self.stereo_fray_x_s.setValue(p.stereo_fray_x_edge)
            if hasattr(self, 'stereo_fray_y_s'):
                self.stereo_fray_y_s.setValue(p.stereo_fray_y_edge)
            if hasattr(self, 'stereo_pattern_combo'):
                self.stereo_pattern_combo.setCurrentText(p.stereo_pattern)
            if hasattr(self, 'stereo_offset_s'):
                self.stereo_offset_s.setValue(p.stereo_pattern_offset)
        finally:
            self._restoring_params = False
        # Trigger a single preview update after restoring all params
        self._mark_halftone_dirty()
        self._art_cache.clear()
        self._cmyk_cache.clear()
        self._arr_cache.clear()
        self._preview_cache.clear()
        # Only trigger render if we're not inside on_open / _load_project_dict
        # Those callers will issue their own final update_preview after setup.
        if not getattr(self, '_suppress_apply_preview', False):
            self.update_preview(force=True)

    def _build_single_layer_rgba(self, layer_idx: int) -> Optional[Image.Image]:
        """Create an RGBA image containing only the specified layer, positioned on a base-size canvas."""
        if layer_idx < 0 or layer_idx >= len(self._layers):
            return None
        lay = self._layers[layer_idx]
        if not lay.visible:
            return None
        # Determine base size from first visible layer (same as _rebuild_composite)
        first_vis = next((l for l in self._layers if l.visible), None)
        if first_vis is None:
            return None
        base_w, base_h = first_vis.image.size
        comp = Image.new("RGBA", (base_w, base_h), (0, 0, 0, 0))
        limg = lay.image
        s = max(0.01, lay.scale_pct / 100.0)
        sw, sh = limg.size
        tw, th = max(1, int(sw * s)), max(1, int(sh * s))
        if (tw, th) != (sw, sh):
            limg = limg.resize((tw, th), Image.Resampling.LANCZOS)
        ox = (base_w - tw) // 2 + lay.offset_x
        oy = (base_h - th) // 2 + lay.offset_y
        if lay.opacity < 1.0:
            limg = limg.copy()
            alpha = limg.getchannel("A")
            alpha = alpha.point(lambda a: int(a * lay.opacity))
            limg.putalpha(alpha)
        tmp = Image.new("RGBA", (base_w, base_h), (0, 0, 0, 0))
        tmp.paste(limg, (ox, oy))
        comp = Image.alpha_composite(comp, tmp)
        return comp

    def _render_single_layer(self, layer_idx: int, p: 'Params', tr: 'Transform') -> Optional[Image.Image]:
        """Render a single layer with the given effect params. Returns artboard-sized RGBA."""
        single_rgba = self._build_single_layer_rgba(layer_idx)
        if single_rgba is None:
            return None
        # Strip registration marks — they are applied once on the final composite
        p_no_regs = replace(p, regs_on=False)
        # Temporarily swap img_full_rgba so the existing pipeline renders this layer only
        saved_img = self.img_full_rgba
        saved_art = self._art_cache
        saved_cmyk = self._cmyk_cache
        saved_arr = self._arr_cache
        self.img_full_rgba = single_rgba
        self._art_cache = {}
        self._cmyk_cache = {}
        self._arr_cache = {}
        try:
            result = self._render_full_res(p_no_regs, tr, skip_content_alpha=True)
            # Apply content alpha so only layer content area has the effect
            content_art = self._compose_on_artboard(single_rgba, tr, transparent_bg=True)
            content_alpha = content_art.getchannel("A")
            if content_alpha.size != result.size:
                content_alpha = content_alpha.resize(result.size, Image.Resampling.NEAREST)
            result.putalpha(content_alpha)
            return result
        finally:
            self.img_full_rgba = saved_img
            self._art_cache = saved_art
            self._cmyk_cache = saved_cmyk
            self._arr_cache = saved_arr

    def _has_per_layer_effects(self) -> bool:
        """Check if non-background layers have individual effect params,
        requiring the per-layer rendering pipeline. Use per-layer pipeline
        whenever multiple non-bg layers exist (even if some are hidden) so
        that each visible layer renders with its own stored params."""
        non_bg_all = [l for l in self._layers if l.name != "Background"]
        non_bg_vis = [l for l in non_bg_all if l.visible]
        return len(non_bg_all) > 1 and len(non_bg_vis) >= 1 and all(l.effect_params is not None for l in non_bg_vis)

    def _get_bg_registration_params(self) -> 'Params':
        """Return registration params from the Background layer's stored effect_params.
        Falls back to the current UI params() if no Background layer exists."""
        for layer in self._layers:
            if layer.name == "Background" and layer.effect_params is not None:
                return layer.effect_params
        return self.params()

    def _sync_registration_to_bg(self):
        """Copy the current UI registration state into the Background layer's effect_params."""
        for layer in self._layers:
            if layer.name == "Background" and layer.effect_params is not None:
                layer.effect_params = replace(
                    layer.effect_params,
                    regs_on=self.regs_chk.isChecked(),
                    reg_size_px=float(self.reg_size_s.value()),
                    reg_offset_px=float(self.reg_offset_s.value()),
                    reg_thickness_pct=float(self.reg_thick_s.value()) / 100.0,
                )
                return

    def _sync_active_layer_params_from_ui(self):
        """Persist current UI params into the active layer before rendering/export."""
        self._sync_registration_to_bg()
        idx = self._selected_layer_idx
        if 0 <= idx < len(self._layers) and not self._layers[idx].locked:
            self._layers[idx].effect_params = self.params()
            self._layer_render_cache.pop(idx, None)

    def _update_preview_per_layer(self, force: bool = False):
        """Render each layer with its own effect params and composite the results."""
        # Sync active layer's params from current UI state so renders use current sliders
        self._sync_active_layer_params_from_ui()

        tr = self._get_transform()
        art_size = self._artboard_size_px_from_transform(tr)
        cache_ctx = (tr.scale_pct, art_size[0], art_size[1])
        if self._layer_render_cache_context != cache_ctx:
            self._layer_render_cache.clear()
            self._layer_render_cache_context = cache_ctx
        canvas = Image.new("RGBA", art_size, (0, 0, 0, 0))
        for i, layer in enumerate(self._layers):
            if not layer.visible:
                continue
            # Background layer is a solid fill — use current bg color directly
            if layer.name == "Background":
                rendered = Image.new("RGBA", art_size, self._bg_rgba())
            elif layer.effect_params is None:
                # No effects — compose raw layer image on artboard
                single_rgba = self._build_single_layer_rgba(i)
                if single_rgba is None:
                    continue
                rendered = self._compose_on_artboard(single_rgba, tr, transparent_bg=True)
            else:
                p = layer.effect_params
                # Always reuse cached render for non-active layers
                if i != self._selected_layer_idx and i in self._layer_render_cache:
                    rendered = self._layer_render_cache[i]
                else:
                    is_active = (i == self._selected_layer_idx)
                    rendered = self._render_single_layer(i, p, tr)
                    if rendered is None:
                        continue
                    # Cache renders for non-active layers, or any layer when not interacting
                    if not self.interacting or not is_active:
                        self._layer_render_cache[i] = rendered
            if rendered.size != art_size:
                rendered = rendered.resize(art_size, Image.Resampling.LANCZOS)
            canvas = Image.alpha_composite(canvas, rendered)
        # Background behind composited layers
        bg = Image.new("RGBA", art_size, self._bg_rgba())
        base_img = Image.alpha_composite(bg, canvas)
        self._last_render_base_rgba = base_img.copy()
        # Apply registration marks from Background layer params
        bg_p = self._get_bg_registration_params()
        if bg_p.regs_on:
            base_img = self._paste_regmarks_bitmap(base_img, bg_p)
        self._prev_pix = pil_to_qpixmap(base_img)
        if self.prev_lbl:
            self.prev_lbl.setPixmap(self._prev_pix)
            self.prev_lbl.update()
        self._halftone_dirty = False
        self._update_scrollbar_ranges()

    def _render_full_res_per_layer(self, tr: 'Transform', single_channel: Optional[str] = None) -> Image.Image:
        """Render all layers with per-layer effects at full resolution for export."""
        self._sync_active_layer_params_from_ui()
        art_size = self._artboard_size_px_from_transform(tr)
        canvas = Image.new("RGBA", art_size, (0, 0, 0, 0))
        for i, layer in enumerate(self._layers):
            if not layer.visible:
                continue
            # Background layer is a solid fill — use current bg color directly
            if layer.name == "Background":
                rendered = Image.new("RGBA", art_size, self._bg_rgba())
            elif layer.effect_params is None:
                # No effects — compose raw layer on artboard
                single_rgba = self._build_single_layer_rgba(i)
                if single_rgba is None:
                    continue
                rendered = self._compose_on_artboard(single_rgba, tr, transparent_bg=True)
            else:
                rendered = self._render_single_layer(i, layer.effect_params, tr)
                if rendered is None:
                    continue
            if rendered.size != art_size:
                rendered = rendered.resize(art_size, Image.Resampling.LANCZOS)
            canvas = Image.alpha_composite(canvas, rendered)
        # Background
        bg = Image.new("RGBA", art_size, self._bg_rgba())
        result = Image.alpha_composite(bg, canvas)
        # Registration marks from Background layer params
        bg_p = self._get_bg_registration_params()
        if bg_p.regs_on:
            result = self._paste_regmarks_bitmap(result, bg_p)
        return result

    def _render_plates_per_layer(self, tr: 'Transform') -> dict:
        """Render clean binary CMYK plate masks across all visible layers.
        
        Returns dict with keys 'c','m','y','k', each an L-mode Image
        (0=ink, 255=no ink) suitable for screen-print separation.
        """
        art_size = self._artboard_size_px_from_transform(tr)
        # Accumulate per-channel coverage as float arrays
        plate_cov: Dict[str, np.ndarray] = {
            ch: np.zeros((art_size[1], art_size[0]), dtype=np.float32) for ch in 'cmyk'
        }
        _ch_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}

        for i, layer in enumerate(self._layers):
            if not layer.visible:
                continue
            if layer.name == "Background":
                continue  # Background is a solid fill, not a halftone layer
            if layer.effect_params is None:
                continue

            p = layer.effect_params
            p_no_regs = replace(p, regs_on=False)
            single_rgba = self._build_single_layer_rgba(i)
            if single_rgba is None:
                continue

            # Temporarily swap img_full_rgba for this layer
            saved_img = self.img_full_rgba
            saved_art = self._art_cache
            saved_cmyk = self._cmyk_cache
            saved_arr = self._arr_cache
            self.img_full_rgba = single_rgba
            self._art_cache = {}
            self._cmyk_cache = {}
            self._arr_cache = {}
            try:
                art_rgba = self._artboard_rgba_cached(tr)
                art_key = self._art_key(tr)

                # Get content alpha mask for this layer
                content_art = self._compose_on_artboard(single_rgba, tr, transparent_bg=True)
                art_trans = content_art
                content_alpha = np.asarray(content_art.getchannel("A"), dtype=np.float32) / 255.0

                if p_no_regs.grayscale_mode:
                    # B/W halftone: only K channel
                    arrK = self._arr_gray_cached(tr, invert=p_no_regs.invert_gray)
                    arrK = self._apply_slice_shift(arrK, p_no_regs)
                    arrK = self._apply_vertical_slice_shift(arrK, p_no_regs)
                    arrK = self._apply_smear_drag(arrK, p_no_regs, 0)
                    arrK = self._apply_macroblock_corruption(arrK, p_no_regs, 0)
                    arrK = self._apply_halftone_slice_shift(arrK, p_no_regs)
                    arrK = self._apply_halftone_vertical_slice_shift(arrK, p_no_regs)
                    arrK = self._maybe_dither_arr(arrK, p_no_regs)

                    if p_no_regs.diffusion_enabled and p_no_regs.diffusion_intensity > 0:
                        layer_cov = np.clip(arrK, 0, 1)
                    else:
                        plate = self._render_plate_from_arr(arrK, p_no_regs, p_no_regs.ang_k, exact_cell=True)
                        plate = self._apply_displacement({'k': plate}, p_no_regs)['k']
                        layer_cov = np.asarray(plate.getchannel("A"), dtype=np.float32) / 255.0

                    # Mask by content alpha and accumulate
                    if content_alpha.shape != layer_cov.shape:
                        from PIL import Image as _PILImg
                        ca_img = _PILImg.fromarray((content_alpha * 255).astype(np.uint8))
                        ca_img = ca_img.resize((layer_cov.shape[1], layer_cov.shape[0]), Image.Resampling.NEAREST)
                        ca_resized = np.asarray(ca_img, dtype=np.float32) / 255.0
                        layer_cov = (layer_cov * ca_resized).astype(np.float32)
                    else:
                        layer_cov = (layer_cov * content_alpha).astype(np.float32)
                    plate_cov['k'] = np.clip(plate_cov['k'] + layer_cov, 0, 1).astype(np.float32)
                else:
                    # Full CMYK
                    def _mk(ch):
                        arr = self._apply_slice_shift(self._arr_cmyk_cached(art_key, art_trans, ch, p_no_regs.invert_gray), p_no_regs)
                        arr = self._apply_vertical_slice_shift(arr, p_no_regs)
                        arr = self._apply_smear_drag(arr, p_no_regs, _ch_idx_map.get(ch, 0))
                        arr = self._apply_macroblock_corruption(arr, p_no_regs, _ch_idx_map.get(ch, 0))
                        arr = self._apply_halftone_slice_shift(arr, p_no_regs)
                        arr = self._apply_halftone_vertical_slice_shift(arr, p_no_regs)
                        return self._maybe_dither_arr(arr, p_no_regs, _ch_idx_map.get(ch, 0))
                    arrs = {ch: _mk(ch) for ch in 'cmyk'}

                    if p_no_regs.cross_channel_bleed > 0:
                        arrs = self._apply_cross_channel_bleed(arrs, p_no_regs)
                    if p_no_regs.channel_desync > 0:
                        arrs = self._apply_channel_desync(arrs, p_no_regs)

                    for ch in 'cmyk':
                        if p_no_regs.diffusion_enabled and p_no_regs.diffusion_intensity > 0:
                            layer_cov = np.clip(arrs[ch], 0, 1)
                        else:
                            plate = self._render_plate_from_arr(arrs[ch], p_no_regs, getattr(p_no_regs, f"ang_{ch}"), None, _ch_idx_map[ch], exact_cell=True)
                            plate = self._apply_displacement({ch: plate}, p_no_regs)[ch]
                            layer_cov = np.asarray(plate.getchannel("A"), dtype=np.float32) / 255.0

                        # Mask by content alpha and accumulate
                        if content_alpha.shape != layer_cov.shape:
                            ca_img = Image.fromarray((content_alpha * 255).astype(np.uint8))
                            ca_img = ca_img.resize((layer_cov.shape[1], layer_cov.shape[0]), Image.Resampling.NEAREST)
                            ca_resized = np.asarray(ca_img, dtype=np.float32) / 255.0
                            layer_cov = (layer_cov * ca_resized).astype(np.float32)
                        else:
                            layer_cov = (layer_cov * content_alpha).astype(np.float32)
                        plate_cov[ch] = np.clip(plate_cov[ch] + layer_cov, 0, 1).astype(np.float32)
            finally:
                self.img_full_rgba = saved_img
                self._art_cache = saved_art
                self._cmyk_cache = saved_cmyk
                self._arr_cache = saved_arr

        # Convert float coverage to clean binary L-mode plates (0=ink, 255=no ink)
        result = {}
        for ch in 'cmyk':
            # Threshold at 50% to get clean binary output for screen printing
            binary = (plate_cov[ch] >= 0.5).astype(np.uint8)
            # 0=ink (black on plate), 255=no ink (white on plate)
            plate_l = Image.fromarray((1 - binary) * 255)
            result[ch] = plate_l
        return result

    def _update_controls_locked(self):
        """Enable/disable all effect controls based on whether the selected layer is locked."""
        idx = self._selected_layer_idx
        locked = (0 <= idx < len(self._layers) and self._layers[idx].locked)
        self.toolbox.setEnabled(not locked)
        self.pixelate_enabled_chk.setEnabled(not locked)
        self.pixelate_block_s.setEnabled(not locked)
        self.mode.setEnabled(not locked)
        self.preview_chan.setEnabled(not locked)
        self.full_comp.setEnabled(not locked)
        self.gray_chk.setEnabled(not locked)
        self.scale_s.setEnabled(not locked)
        self.scale_input.setEnabled(not locked)

    def _on_layer_selected(self, row: int):
        if row < 0 or row >= len(self._layers):
            self._selected_layer_idx = -1
            return
        # Save current params to previously selected layer (skip if locked)
        old_idx = self._selected_layer_idx
        if 0 <= old_idx < len(self._layers) and not self._layers[old_idx].locked:
            self._layers[old_idx].effect_params = self.params()
            # Invalidate old layer's render cache so it re-renders with saved params
            self._layer_render_cache.pop(old_idx, None)
        self._layer_render_cache.pop(row, None)  # Clear cache for newly selected layer
        self._preview_cache.clear()
        self._selected_layer_idx = row
        self._sync_scale_ui_to_selected_layer()
        new_layer = self._layers[row]
        # Don't apply a locked layer's params to the UI — that would change the
        # active render output.  Just disable controls so user sees it's locked.
        if not new_layer.locked:
            if new_layer.effect_params is not None:
                self._apply_params_to_ui(new_layer.effect_params)
            else:
                new_layer.effect_params = self._default_params()
                self._apply_params_to_ui(new_layer.effect_params)
        self._update_controls_locked()

    def _on_layer_toggle_vis(self):
        idx = self._selected_layer_idx
        if idx < 0 or idx >= len(self._layers):
            return
        self._layers[idx].visible = not self._layers[idx].visible
        self._sync_layer_list_widget()
        self._rebuild_composite()
        self._layer_render_cache.clear()
        self._preview_cache.clear()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _on_layer_toggle_lock(self):
        idx = self._selected_layer_idx
        if idx < 0 or idx >= len(self._layers):
            return
        self._layers[idx].locked = not self._layers[idx].locked
        # If just locked, restore saved params to UI (revert any unsaved slider moves)
        ep = self._layers[idx].effect_params
        if self._layers[idx].locked and ep is not None:
            self._apply_params_to_ui(ep)
        self._update_controls_locked()
        self._sync_layer_list_widget()

    def _on_layer_move_up(self):
        idx = self._selected_layer_idx
        if idx <= 0 or idx >= len(self._layers):
            return
        if self._layers[idx].locked:
            return
        self._layers[idx], self._layers[idx - 1] = self._layers[idx - 1], self._layers[idx]
        self._selected_layer_idx = idx - 1
        self._sync_layer_list_widget()
        self._rebuild_composite()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _on_layer_move_down(self):
        idx = self._selected_layer_idx
        if idx < 0 or idx >= len(self._layers) - 1:
            return
        if self._layers[idx].locked:
            return
        self._layers[idx], self._layers[idx + 1] = self._layers[idx + 1], self._layers[idx]
        self._selected_layer_idx = idx + 1
        self._sync_layer_list_widget()
        self._rebuild_composite()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _on_layer_remove(self):
        idx = self._selected_layer_idx
        if idx < 0 or idx >= len(self._layers):
            return
        if self._layers[idx].locked:
            return
        self._layers.pop(idx)
        if self._selected_layer_idx >= len(self._layers):
            self._selected_layer_idx = len(self._layers) - 1
        self._sync_layer_list_widget()
        self._rebuild_composite()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _on_add_asset(self):
        paths, _ = QFileDialog.getOpenFileNames(self, "add asset(s)", self._working_dir or "", "Images (*.png *.jpg *.jpeg *.tif *.tiff)")
        if not paths:
            return
        self._push_undo_now()
        # Freeze the current per-layer state so newly created layers do not
        # inherit any existing layer's parameters during the batch import.
        self._sync_active_layer_params_from_ui()
        preserved_layers = [
            asdict(lay.effect_params) if lay.effect_params is not None else None
            for lay in self._layers
        ]
        preserved_count = len(self._layers)
        # Suppress renders during batch add — single render at the end
        self._suppress_apply_preview = True
        self._restoring_params = True
        for path in paths:
            try:
                im = load_image_capped(path)
            except Exception as e:
                QMessageBox.critical(self, "error", str(e))
                continue
            tr = self._get_transform()
            art_w, art_h = self._artboard_size_px_from_transform(tr)
            # Auto-add background layer if this is the first asset
            if not self._layers:
                # Initialize the stack on the artboard dimensions so imported
                # assets are centered on the artboard, not source-image bounds.
                bg = Image.new("RGBA", (art_w, art_h), self._bg_rgba())
                self._add_layer(bg, "Background")
                # Initialize Background layer with current UI params so registration is stored
                bg_idx = next(i for i, l in enumerate(self._layers) if l.name == "Background")
                self._layers[bg_idx].effect_params = self.params()
            name = os.path.basename(path)
            # Paste asset onto a canvas matching existing layer size
            if self._layers:
                base_w, base_h = self._layers[0].image.size
                iw, ih = im.size
                # Scale down if asset is larger than canvas
                fit_s = min(base_w / iw, base_h / ih, 1.0)
                if fit_s < 1.0:
                    im = im.resize((max(1, int(iw * fit_s)), max(1, int(ih * fit_s))), Image.Resampling.LANCZOS)
                iw, ih = im.size
                img_canvas = Image.new("RGBA", (base_w, base_h), (0, 0, 0, 0))
                img_canvas.paste(im, ((base_w - iw) // 2, (base_h - ih) // 2), im)
                self._add_layer(img_canvas, name)
            else:
                self._add_layer(im, name)
            # Restore any existing layers to their pre-import params in case
            # layer selection/UI restoration touched them during the add flow.
            for idx in range(preserved_count):
                snap = preserved_layers[idx]
                self._layers[idx].effect_params = self._params_from_dict(snap) if snap is not None else None
        self._restoring_params = False
        self._suppress_apply_preview = False
        self.export_png_btn.setEnabled(True)
        self.export_svg_btn.setEnabled(True)
        self.export_pdf_btn.setEnabled(True)
        self.export_tiff_btn.setEnabled(True)
        self._rebuild_composite()
        self._layer_render_cache.clear()
        self._art_cache.clear(); self._cmyk_cache.clear(); self._arr_cache.clear()
        self._preview_cache.clear()
        self.update_preview(force=True)

    # ---- SCROLLBAR HANDLERS ----

    def _on_hscroll(self, val: int):
        if self._scroll_updating:
            return
        if self.prev_lbl:
            self.prev_lbl._view_pan_x = -val
            self.prev_lbl.update()

    def _on_vscroll(self, val: int):
        if self._scroll_updating:
            return
        if self.prev_lbl:
            self.prev_lbl._view_pan_y = -val
            self.prev_lbl.update()

    def _update_scrollbar_ranges(self):
        if not self.prev_lbl or not self._prev_pix:
            return
        pm_w = self._prev_pix.width()
        pm_h = self._prev_pix.height()
        # Account for pixmap_scale: paintEvent draws at zoom_scale / pixmap_scale
        z = self.prev_lbl.zoom_scale / max(0.01, self.prev_lbl._pixmap_scale)
        draw_w = int(pm_w * z)
        draw_h = int(pm_h * z)
        label_w = max(1, self.prev_lbl.width())
        label_h = max(1, self.prev_lbl.height())

        self._scroll_updating = True
        overflow_x = max(0, (draw_w - label_w) // 2)
        overflow_y = max(0, (draw_h - label_h) // 2)
        self._h_scroll.setRange(-overflow_x, overflow_x)
        self._h_scroll.setPageStep(label_w)
        self._h_scroll.setValue(int(-self.prev_lbl._view_pan_x))
        self._v_scroll.setRange(-overflow_y, overflow_y)
        self._v_scroll.setPageStep(label_h)
        self._v_scroll.setValue(int(-self.prev_lbl._view_pan_y))
        self._scroll_updating = False
        
    def _get_channel_color(self, ch: str) -> tuple:
        """Get the RGBA color for a CMYK channel."""
        return {
            'c': (0, 255, 255, 255),
            'm': (255, 0, 255, 255),
            'y': (255, 255, 0, 255),
            'k': (0, 0, 0, 255)
        }.get(ch, (0, 0, 0, 255))

    def _default_params(self) -> 'Params':
        """Return a Params object with all default/reset values for a new layer."""
        return Params(
            mode="dot", cell=16.0, elem=1.0, stroke=1.0, smoothing_pct=30.0,
            preview_channel="composite", ang_c=15.0, ang_m=75.0, ang_y=0.0, ang_k=45.0,
            full_composite_preview=True,
            regs_on=False, reg_size_px=15.0, reg_offset_px=15.0, reg_thickness_pct=1.0,
            grayscale_mode=False, invert_gray=False,
            warp_amt=0.0, warp_scale=1.0,
            slice_shift_amt=0, vertical_slice_shift_amt=0,
            halftone_slice_shift_amt=0, halftone_vertical_slice_shift_amt=0,
            displace_c=(0, 0), displace_m=(0, 0), displace_y=(0, 0), displace_k=(0, 0),
            diffusion_enabled=False, diffusion_algorithm="floyd-steinberg",
            diffusion_intensity=0.5, diffusion_levels=8,
            diffusion_sharpen_strength=0.0, diffusion_sharpen_radius=1.0,
            diffusion_denoise=0.0, diffusion_modulation="none", diffusion_mod_strength=0.5,
            broken_kernel=0.0, directional_bias=0.0, directional_bias_angle=0.0,
            error_overflow=0.0, diffusion_reset=0.0, cross_channel_bleed=0.0,
            smear_drag=0.0, smear_length=24, smear_vertical=False,
            macroblock_corrupt=0.0, macroblock_dropout=0.25,
            block_shift=0.0, block_shift_size=16, channel_desync=0.0,
            bitmap_sort=0.0, bitmap_sort_vertical=False,
            line_length_pct=100.0, line_width_pct=1.0, line_weight_variation=0.25,
            line_density_pct=1.0, line_taper_pct=0.15, stroke_randomness=0.1,
            cross_hatching_enabled=False, cross_hatching_angle=90.0, hatching_invert=False,
            cross_hatch_threshold=40.0, dot_gap=0.0,
            lines_flow_path=[], lines_use_flow_path=False, lines_path_influence=100.0,
            ascii_enabled=False, ascii_charset="default", ascii_custom_chars="",
            ascii_cell_size=10.0, ascii_invert=False, ascii_threshold_levels=10,
            ascii_font_size=10.0, ascii_line_spacing=1.0, ascii_keep_text_editable=False,
            pixelate_enabled=False, pixelate_block_size=20,
            generative_enabled=False, generative_mode="flow fields",
            generative_invert=False, generative_per_channel=False,
            flow_noise_scale=100.0, flow_line_density=50.0, flow_line_length=50.0,
            flow_step_size=2.0, flow_angle_offset=0.0, flow_image_influence=50.0,
            flow_turbulence=0.0, flow_line_width=1.0,
            spiro_R=100.0, spiro_r=40.0, spiro_d=30.0, spiro_num_curves=3,
            spiro_rotation=0.0, spiro_line_width=1.0, spiro_scale=100.0, spiro_complexity=50.0,
            rd_feed_rate=0.055, rd_kill_rate=0.062, rd_iterations=1000,
            rd_scale=100.0, rd_threshold=50.0, rd_diffusion_a=1.0, rd_diffusion_b=0.5,
            rd_line_width=1.0, rd_use_gpu=False,
            geoflow_shape="circle", geoflow_count=100,
            geoflow_size_min=10.0, geoflow_size_max=50.0, geoflow_noise_scale=100.0,
            geoflow_rotation=True, geoflow_size_by_flow=False, geoflow_fill=True,
            geoflow_spacing=50.0, geoflow_angle_offset=0.0, geoflow_turbulence=0.0,
            generative_line_width=1.0,
            stereogram_mode=False, stereo_depth_intensity=50, stereo_separation=60,
            stereo_smooth_depth=30, stereo_invert_depth=False, stereo_num_colors=3,
            stereo_dot_size=4, stereo_fray_x_edge=0, stereo_fray_y_edge=0,
            stereo_pattern="random dots", stereo_pattern_offset=0,
            stereo_color_c="#00FFFF", stereo_color_m="#FF00FF",
            stereo_color_y="#FFFF00", stereo_color_k="#000000",
        )

    def params(self) -> Params:
        # Global invert logic - if any accordion section has invert checked, apply invert
        global_invert = (
            (hasattr(self, 'halftone_invert_chk') and self.halftone_invert_chk.isChecked()) or
            (hasattr(self, 'glitch_invert_chk') and self.glitch_invert_chk.isChecked()) or
            (hasattr(self, 'diffusion_invert_chk') and self.diffusion_invert_chk.isChecked())
        )
        
        return Params(
            mode=self.mode.currentText(), cell=self.cell_s.value()/100.0,
            elem=1.0, stroke=self.str_s.value()/100.0,
            smoothing_pct=30.0,
            preview_channel=self.preview_chan.currentText(),
            ang_c=float(self.ang_c.value()), ang_m=float(self.ang_m.value()),
            ang_y=float(self.ang_y.value()), ang_k=float(self.ang_k.value()),
            full_composite_preview=self.full_comp.isChecked(),
            regs_on=self.regs_chk.isChecked(), reg_size_px=float(self.reg_size_s.value()),
            reg_offset_px=float(self.reg_offset_s.value()),
            reg_thickness_pct=float(self.reg_thick_s.value()) / 100.0,
            grayscale_mode=self.gray_chk.isChecked(), invert_gray=global_invert,
            warp_amt=self.warp_amt_s.value() / 10.0, warp_scale=self.warp_scale_s.value() / 100.0,
            slice_shift_amt=self.slice_shift_s.value(),
            vertical_slice_shift_amt=self.vertical_slice_shift_s.value(),
            slice_size_px=self.slice_size_s.value() if hasattr(self, 'slice_size_s') else 20,
            slice_angle=float(self.slice_angle_s.value()) if hasattr(self, 'slice_angle_s') else 0.0,
            vertical_slice_size_px=self.vertical_slice_size_s.value() if hasattr(self, 'vertical_slice_size_s') else 20,
            vertical_slice_angle=float(self.vertical_slice_angle_s.value()) if hasattr(self, 'vertical_slice_angle_s') else 0.0,
            halftone_slice_shift_amt=self.ht_slice_s.value(),
            halftone_vertical_slice_shift_amt=self.ht_vslice_s.value(),
            displace_c=(self.disp_sliders['c'][0].value(), self.disp_sliders['c'][1].value()),
            displace_m=(self.disp_sliders['m'][0].value(), self.disp_sliders['m'][1].value()),
            displace_y=(self.disp_sliders['y'][0].value(), self.disp_sliders['y'][1].value()),
            displace_k=(self.disp_sliders['k'][0].value(), self.disp_sliders['k'][1].value()),
            # Diffusion parameters
            diffusion_enabled=hasattr(self, 'diffusion_enabled_chk') and self.diffusion_enabled_chk.isChecked(),
            diffusion_algorithm=getattr(self, 'diffusion_algo_combo', QComboBox()).currentText() if hasattr(self, 'diffusion_algo_combo') else "floyd-steinberg",
            diffusion_intensity=getattr(self, 'diffusion_intensity_s', QSlider()).value() / 100.0 if hasattr(self, 'diffusion_intensity_s') else 0.5,
            diffusion_levels=getattr(self, 'diffusion_levels_s', QSlider()).value() if hasattr(self, 'diffusion_levels_s') else 8,
            diffusion_sharpen_strength=getattr(self, 'diffusion_sharpen_s', QSlider()).value() / 100.0 if hasattr(self, 'diffusion_sharpen_s') else 0.0,
            diffusion_sharpen_radius=float(getattr(self, 'diffusion_radius_s', QSlider()).value()) if hasattr(self, 'diffusion_radius_s') else 1.0,
            diffusion_denoise=getattr(self, 'diffusion_denoise_s', QSlider()).value() / 100.0 if hasattr(self, 'diffusion_denoise_s') else 0.0,
            diffusion_modulation=getattr(self, 'diffusion_mod_combo', QComboBox()).currentText() if hasattr(self, 'diffusion_mod_combo') else "none",
            diffusion_mod_strength=getattr(self, 'diffusion_mod_strength_s', QSlider()).value() / 100.0 if hasattr(self, 'diffusion_mod_strength_s') else 0.5,
            # Diffusion glitch effects
            broken_kernel=getattr(self, 'broken_kernel_s', QSlider()).value() / 100.0 if hasattr(self, 'broken_kernel_s') else 0.0,
            directional_bias=getattr(self, 'dir_bias_s', QSlider()).value() / 100.0 if hasattr(self, 'dir_bias_s') else 0.0,
            directional_bias_angle=getattr(self, 'dir_bias_angle_s', QSlider()).value() if hasattr(self, 'dir_bias_angle_s') else 0.0,
            error_overflow=getattr(self, 'error_overflow_s', QSlider()).value() / 100.0 if hasattr(self, 'error_overflow_s') else 0.0,
            diffusion_reset=getattr(self, 'diffusion_reset_s', QSlider()).value() / 100.0 if hasattr(self, 'diffusion_reset_s') else 0.0,
            cross_channel_bleed=getattr(self, 'cross_bleed_s', QSlider()).value() / 100.0 if hasattr(self, 'cross_bleed_s') else 0.0,
            # Datamosh effects
            smear_drag=getattr(self, 'smear_drag_s', QSlider()).value() / 100.0 if hasattr(self, 'smear_drag_s') else 0.0,
            smear_length=getattr(self, 'smear_length_s', QSlider()).value() if hasattr(self, 'smear_length_s') else 24,
            smear_vertical=getattr(self, 'smear_vertical_chk', QCheckBox()).isChecked() if hasattr(self, 'smear_vertical_chk') else False,
            macroblock_corrupt=getattr(self, 'macroblock_s', QSlider()).value() / 100.0 if hasattr(self, 'macroblock_s') else 0.0,
            macroblock_dropout=getattr(self, 'macroblock_dropout_s', QSlider()).value() / 100.0 if hasattr(self, 'macroblock_dropout_s') else 0.25,
            block_shift=getattr(self, 'block_shift_s', QSlider()).value() / 100.0 if hasattr(self, 'block_shift_s') else 0.0,
            block_shift_size=getattr(self, 'block_size_s', QSlider()).value() if hasattr(self, 'block_size_s') else 16,
            channel_desync=getattr(self, 'chan_desync_s', QSlider()).value() / 100.0 if hasattr(self, 'chan_desync_s') else 0.0,
            bitmap_sort=getattr(self, 'bitmap_sort_s', QSlider()).value() / 100.0 if hasattr(self, 'bitmap_sort_s') else 0.0,
            bitmap_sort_vertical=getattr(self, 'bitmap_sort_vert_chk', QCheckBox()).isChecked() if hasattr(self, 'bitmap_sort_vert_chk') else False,
            
            # Lines control parameters
            line_length_pct=getattr(self, 'line_length_s', QSlider()).value() if hasattr(self, 'line_length_s') else 100.0,
            line_width_pct=getattr(self, 'line_width_s', QSlider()).value() / 100.0 if hasattr(self, 'line_width_s') else 1.0,
            line_weight_variation=getattr(self, 'line_weight_s', QSlider()).value() / 100.0 if hasattr(self, 'line_weight_s') else 0.25,
            line_density_pct=getattr(self, 'line_density_s', QSlider()).value() / 100.0 if hasattr(self, 'line_density_s') else 1.0,
            line_taper_pct=getattr(self, 'line_taper_s', QSlider()).value() / 100.0 if hasattr(self, 'line_taper_s') else 0.15,
            stroke_randomness=getattr(self, 'stroke_random_s', QSlider()).value() / 100.0 if hasattr(self, 'stroke_random_s') else 0.1,
            cross_hatching_enabled=False,  # No longer used
            cross_hatching_angle=90.0,  # No longer used
            hatching_invert=getattr(self, 'lines_invert_chk', QCheckBox()).isChecked() if hasattr(self, 'lines_invert_chk') else False,
            cross_hatch_threshold=40.0,  # No longer used
            # Lines flow path parameters
            lines_flow_path=getattr(self, '_lines_flow_path', []) if hasattr(self, '_lines_flow_path') else [],
            lines_use_flow_path=getattr(self, 'lines_use_flow_path_chk', QCheckBox()).isChecked() if hasattr(self, 'lines_use_flow_path_chk') else False,
            lines_path_influence=float(getattr(self, 'lines_path_influence_s', QSlider()).value()) if hasattr(self, 'lines_path_influence_s') else 100.0,
            # ASCII Art parameters
            ascii_enabled=getattr(self, 'ascii_enabled_chk', QCheckBox()).isChecked() if hasattr(self, 'ascii_enabled_chk') else False,
            ascii_charset=getattr(self, 'ascii_charset_combo', QComboBox()).currentText() if hasattr(self, 'ascii_charset_combo') else "default",
            ascii_custom_chars=getattr(self, 'ascii_custom_input', QLineEdit()).text() if hasattr(self, 'ascii_custom_input') else "",
            ascii_cell_size=float(getattr(self, 'ascii_cell_size_s', QSlider()).value()) if hasattr(self, 'ascii_cell_size_s') else 10.0,
            ascii_invert=getattr(self, 'ascii_invert_chk', QCheckBox()).isChecked() if hasattr(self, 'ascii_invert_chk') else False,
            ascii_threshold_levels=getattr(self, 'ascii_threshold_s', QSlider()).value() if hasattr(self, 'ascii_threshold_s') else 10,
            ascii_font_size=float(getattr(self, 'ascii_font_size_s', QSlider()).value()) if hasattr(self, 'ascii_font_size_s') else 10.0,
            ascii_line_spacing=getattr(self, 'ascii_spacing_s', QSlider()).value() / 100.0 if hasattr(self, 'ascii_spacing_s') else 1.0,
            ascii_keep_text_editable=getattr(self, 'ascii_keep_text_chk', QCheckBox()).isChecked() if hasattr(self, 'ascii_keep_text_chk') else False,
            # CMYK Pixelate parameters
            pixelate_enabled=hasattr(self, 'pixelate_enabled_chk') and self.pixelate_enabled_chk.isChecked(),
            pixelate_block_size=getattr(self, 'pixelate_block_s', QSlider()).value() if hasattr(self, 'pixelate_block_s') else 20,
            # Stereogram parameters
            stereogram_mode=getattr(self, 'stereo_mode_chk', QCheckBox()).isChecked() if hasattr(self, 'stereo_mode_chk') else False,
            stereo_depth_intensity=getattr(self, 'stereo_depth_s', QSlider()).value() if hasattr(self, 'stereo_depth_s') else 50,
            stereo_separation=getattr(self, 'stereo_sep_s', QSlider()).value() if hasattr(self, 'stereo_sep_s') else 60,
            stereo_smooth_depth=getattr(self, 'stereo_smooth_s', QSlider()).value() if hasattr(self, 'stereo_smooth_s') else 30,
            stereo_invert_depth=getattr(self, 'stereo_invert_chk', QCheckBox()).isChecked() if hasattr(self, 'stereo_invert_chk') else False,
            stereo_num_colors=3 if not hasattr(self, 'stereo_colors_combo') or "3" in self.stereo_colors_combo.currentText() else 4,
            stereo_dot_size=getattr(self, 'stereo_dot_s', QSlider()).value() if hasattr(self, 'stereo_dot_s') else 4,
            stereo_fray_x_edge=getattr(self, 'stereo_fray_x_s', QSlider()).value() if hasattr(self, 'stereo_fray_x_s') else 0,
            stereo_fray_y_edge=getattr(self, 'stereo_fray_y_s', QSlider()).value() if hasattr(self, 'stereo_fray_y_s') else 0,
            stereo_pattern=getattr(self, 'stereo_pattern_combo', QComboBox()).currentText() if hasattr(self, 'stereo_pattern_combo') else "random dots",
            stereo_pattern_offset=getattr(self, 'stereo_offset_s', QSlider()).value() if hasattr(self, 'stereo_offset_s') else 0,
            stereo_color_c=getattr(self, 'stereo_color_c_hex', "#00FFFF"),
            stereo_color_m=getattr(self, 'stereo_color_m_hex', "#FF00FF"),
            stereo_color_y=getattr(self, 'stereo_color_y_hex', "#FFFF00"),
            stereo_color_k=getattr(self, 'stereo_color_k_hex', "#000000"),
        )

    def on_open(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "open file", self._working_dir or "",
            "All supported (*.png *.jpg *.jpeg *.tif *.tiff *.htg);;Images (*.png *.jpg *.jpeg *.tif *.tiff);;Halftone Project (*.htg)")
        if not path:
            return
        if path.lower().endswith('.htg'):
            # Load project file
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self._load_project_dict(data)
                self._project_path = path
                self.statusBar().showMessage(f"project loaded: {os.path.basename(path)}")
            except Exception as e:
                QMessageBox.critical(self, "load failed", str(e))
            return
        # Image file — start fresh
        self._push_undo_now()
        try:
            im = load_image_capped(path)
        except Exception as e:
            QMessageBox.critical(self, "error", str(e)); return
        self._layers.clear()
        self._selected_layer_idx = -1
        name = os.path.basename(path)
        w, h = im.size
        # --- Suppress cascading renders during setup ---
        self._restoring_params = True
        self._suppress_apply_preview = True
        # Detect orientation so artboard dimensions match image aspect
        self._auto_detect_orientation(w, h)
        # Compute artboard size and resize image to fit inside it
        tr = self._get_transform()
        art_w, art_h = self._artboard_size_px_from_transform(tr)
        fit_s = min(art_w / max(1, w), art_h / max(1, h))
        if fit_s < 1.0:
            im = im.resize((max(1, int(w * fit_s)), max(1, int(h * fit_s))), Image.Resampling.LANCZOS)
        # Background layer at artboard size
        bg = Image.new("RGBA", (art_w, art_h), self._bg_rgba())
        self._add_layer(bg, "Background")
        self._restoring_params = True          # _add_layer resets via _apply_params_to_ui
        bg_idx = next(i for i, l in enumerate(self._layers) if l.name == "Background")
        self._layers[bg_idx].effect_params = self.params()
        # Image layer: paste centered on artboard-sized transparent canvas
        img_canvas = Image.new("RGBA", (art_w, art_h), (0, 0, 0, 0))
        iw, ih = im.size
        img_canvas.paste(im, ((art_w - iw) // 2, (art_h - ih) // 2))
        self._add_layer(img_canvas, name)
        self._restoring_params = True          # _add_layer resets via _apply_params_to_ui
        # Clear all caches
        self._art_cache.clear(); self._cmyk_cache.clear(); self._arr_cache.clear()
        self._layer_render_cache.clear()
        self._last_render_base_rgba = None; self._mark_halftone_dirty()
        self._content_alpha_cache_key = None; self._content_alpha_cache_img = None
        self._offset_x = 0; self._offset_y = 0
        self.info.setText(f"{name} \u2022 {w}\u00d7{h}")
        if hasattr(self, '_lines_flow_path'):
            self._lines_flow_path = []
        if self.prev_lbl is not None and hasattr(self.prev_lbl, 'clear_flow_path'):
            self.prev_lbl.clear_flow_path()
        self.export_png_btn.setEnabled(True); self.export_svg_btn.setEnabled(True)
        self.export_pdf_btn.setEnabled(True); self.export_tiff_btn.setEnabled(True)
        if not self._working_dir:
            self._working_dir = os.path.dirname(path)
        # --- Re-enable control handling and issue a single render ---
        self._restoring_params = False
        self._suppress_apply_preview = False
        # Force a fresh composite so img_full_rgba is up-to-date
        self._rebuild_composite()
        # Auto-fit the image scale so it fills the artboard, regardless of img_full_rgba size
        tr = self._get_transform()
        art_W, art_H = self._artboard_size_px_from_transform(tr)
        if self.img_full_rgba is not None:
            sw, sh = self.img_full_rgba.size
            fit_scale = max(0.01, min(art_W / max(1, sw), art_H / max(1, sh))) * 100.0
        else:
            fit_scale = 100.0
        if 0 <= self._selected_layer_idx < len(self._layers):
            self._layers[self._selected_layer_idx].scale_pct = int(round(fit_scale))
        self._sync_scale_ui_to_selected_layer()
        self._rebuild_composite()
        self._art_cache.clear(); self._cmyk_cache.clear(); self._arr_cache.clear()
        self._preview_cache.clear()
        self.update_preview(force=True)

    def on_load_shape(self):
        if not HAS_SVGPATHTOOLS:
            QMessageBox.warning(self, "unavailable", "Install 'svgpathtools' to use custom shapes."); return
        path, _ = QFileDialog.getOpenFileName(self, "load dot shape (SVG)", "", "SVG (*.svg)")
        if not path: return
        try:
            if not HAS_SVGPATHTOOLS or svg2paths2 is None:
                raise ImportError("svgpathtools not available")
            assert svg2paths2 is not None
            svg2paths2_result = svg2paths2(path)
            paths = svg2paths2_result[0]
            if SVGPath is not None:
                paths = [p for p in paths if isinstance(p, SVGPath) and len(p) > 0]
            else:
                paths = [p for p in paths if len(p) > 0]
            if not paths: raise ValueError("no vector paths found.")
            minx=miny=1e9; maxx=maxy=-1e9
            for pth in paths:
                x0,x1,y0,y1 = pth.bbox(); minx=min(minx,x0); maxx=max(maxx,x1); miny=min(miny,y0); maxy=max(maxy,y1)
            self.shape_paths = paths; self.shape_bbox=(minx,miny,maxx,maxy)
            self._sprite_cache["custom-96"] = self._rasterize_svg_paths(paths, self.shape_bbox, out_size=96)
            if "custom" not in [self.mode.itemText(i) for i in range(self.mode.count())]:
                self.mode.addItem("custom")
            self.mode.setCurrentText("custom")
            self._clear_sprite_caches(); self.statusBar().showMessage(f"dot shape loaded: {os.path.basename(path)}")
            self._mark_halftone_dirty(); self._on_control_changed(); self._schedule_moire_update()
        except Exception as e:
            QMessageBox.critical(self, "load failed", str(e))

    def on_load_reg(self):
        if not HAS_SVGPATHTOOLS:
            QMessageBox.warning(self, "unavailable", "Install 'svgpathtools' to load a custom reg mark SVG.")
            return
        path, _ = QFileDialog.getOpenFileName(self, "load registration mark (SVG)", "", "SVG (*.svg)")
        if not path:
            return
        try:
            if not HAS_SVGPATHTOOLS or svg2paths2 is None:
                raise ImportError("svgpathtools not available")
            assert svg2paths2 is not None
            svg2paths2_result = svg2paths2(path)
            paths = svg2paths2_result[0]
            if SVGPath is not None:
                paths = [p for p in paths if isinstance(p, SVGPath) and len(p) > 0]
            else:
                paths = [p for p in paths if len(p) > 0]
            if not paths:
                raise ValueError("no vector paths found.")
            minx = miny = 1e9; maxx = maxy = -1e9
            for pth in paths:
                x0, x1, y0, y1 = pth.bbox()
                minx = min(minx, x0); maxx = max(maxx, x1); miny = min(miny, y0); maxy = max(maxy, y1)
            self.reg_paths = paths
            self.reg_bbox = (minx, miny, maxx, maxy)
            self.statusBar().showMessage(f"reg mark loaded: {os.path.basename(path)}")
            self._on_regs_changed()
        except Exception as e:
            QMessageBox.critical(self, "load failed", str(e))

    def _on_slider_pressed(self):
        self.interacting = True

    def _on_slider_released(self):
        self.interacting = False
        self._preview_cache.clear()
        self._interact_cmyk_cache_key = None
        self._interact_cmyk_cache_img = None
        self.update_preview(force=True)
        self._schedule_moire_update()

    def _schedule_moire_update(self):
        """Debounced moire tile update — avoids redundant renders during rapid changes."""
        if hasattr(self, '_moire_timer'):
            self._moire_timer.stop()
            self._moire_timer.start(300)

    def _throttled_slider_update(self):
        """Mark dirty and either throttle (during drag) or do full update."""
        idx = self._selected_layer_idx
        if 0 <= idx < len(self._layers) and self._layers[idx].locked:
            return
        self._mark_halftone_dirty()
        if self.interacting:
            if hasattr(self, '_interact_timer'):
                self._interact_timer.stop()
                self._interact_timer.start(30)
        else:
            self._on_control_changed()

    def _on_control_changed(self):
        if self._restoring_params:
            return  # Skip during programmatic UI restore
        # Don't modify locked layers
        idx = self._selected_layer_idx
        if 0 <= idx < len(self._layers) and self._layers[idx].locked:
            self.statusBar().showMessage("\U0001f512 layer is locked", 1500)
            return
        self._mark_halftone_dirty()
        
        # Save current params to active layer
        if 0 <= self._selected_layer_idx < len(self._layers):
            self._layers[self._selected_layer_idx].effect_params = self.params()
            # Invalidate render cache for this layer
            self._layer_render_cache.pop(self._selected_layer_idx, None)
            if not self._layer_list_dirty:
                self._layer_list_dirty = True
                QTimer.singleShot(250, self._deferred_sync_layer_list)
        # Keep registration in sync with Background layer
        self._sync_registration_to_bg()

        # Schedule auto-snapshot for undo (debounced)
        if hasattr(self, '_undo_timer'):
            self._undo_timer.stop()
            self._undo_timer.start()
        
        # Smart caching - only clear what's necessary
        current_params = self.params()
        params_hash = self._get_params_hash(current_params)
        
        if params_hash != self._last_params_hash:
            prev_p = getattr(self, '_last_params_obj', None)
            # _arr_cache and _noise_cache are keyed by (art_key, channel, invert) —
            # halftone/effect param changes don't affect those keys, so no clear needed.
            # They are correctly cleared in _on_artboard_changed and _rebuild_composite.
            # Only clear shape-related caches when the shape mode changes.
            if prev_p is None or prev_p.mode != current_params.mode or prev_p.elem != current_params.elem:
                self._mask_cache.clear()
                self._rotated_sprite_cache.clear()
            self._preview_cache.clear()  # Clear preview cache when parameters change
            self._last_params_obj = current_params
            self._last_params_hash = params_hash
        
        # Simplified preview timing - only for non-interactive updates
        if not self.interacting:
            # 50ms debounce: batches rapid combo/checkbox changes into one render
            self._render_timer.stop()
            self._render_timer.start(50)
    
    def _show_performance_status(self):
        """Display available performance optimizations in status bar"""
        status_parts = []
        
        if HAS_NUMBA:
            status_parts.append("Numba: CPU acceleration enabled")
        if HAS_CUPY:
            status_parts.append("CuPy: GPU acceleration enabled")
        if HAS_OPENCV:
            status_parts.append("OpenCV: Fast image processing enabled")
            
        if status_parts:
            status_text = " | ".join(status_parts)
        else:
            status_text = "Using standard NumPy processing"
            
        # Show in window title temporarily
        original_title = self.windowTitle()
        self.setWindowTitle(f"{original_title} - Performance: {status_text}")
        
        # Reset title after 3 seconds
        QTimer.singleShot(3000, lambda: self.setWindowTitle(original_title))

    def _ultra_fast_preview(self):
        """Kept for compatibility; full-quality preview is handled by update_preview()."""
        if not self.interacting:
            return
        self.update_preview(force=False)

    def _auto_detect_orientation(self, width: int, height: int):
        """Auto-detect and set artboard orientation based on image dimensions."""
        try:
            aspect_ratio = width / height
            if aspect_ratio > 1.1:
                target_orientation = "landscape"
            elif aspect_ratio < 0.9:
                target_orientation = "portrait"
            else:
                return
            if self._doc_orientation != target_orientation:
                self._doc_orientation = target_orientation
                self.orientation.blockSignals(True)
                self.orientation.setCurrentText(target_orientation)
                self.orientation.blockSignals(False)
                self._on_artboard_changed()
                self._update_titles()
                self.info.setText(f"{self.info.text()} • auto-set to {target_orientation}")
        except Exception:
            pass

    def _background_cleanup(self):
        """Clean up caches in background to maintain performance"""
        # Limit cache sizes to prevent memory bloat
        if len(self._arr_cache) > 100:
            # Remove oldest 50% of cache entries
            keys_to_remove = list(self._arr_cache.keys())[:len(self._arr_cache)//2]
            for key in keys_to_remove:
                self._arr_cache.pop(key, None)
        
        if len(self._preview_cache) > 20:
            # Remove oldest preview cache entries
            keys_to_remove = list(self._preview_cache.keys())[:len(self._preview_cache)//2]
            for key in keys_to_remove:
                self._preview_cache.pop(key, None)
                
        if hasattr(self, '_noise_cache') and len(self._noise_cache) > 15:
            # Clean noise cache
            self._noise_cache.clear()

    def _get_params_hash(self, p) -> str:
        """Get a hash of current parameters for caching — uses fast tuple hash"""
        try:
            from dataclasses import astuple
            return str(hash(astuple(p)))
        except Exception:
            return str(hash((
                p.mode, p.cell, p.elem, p.stroke, p.invert_gray,
                p.ang_c, p.ang_m, p.ang_y, p.ang_k,
                p.warp_amt, p.warp_scale,
                p.slice_shift_amt, p.vertical_slice_shift_amt,
                p.diffusion_enabled, p.diffusion_algorithm, p.diffusion_intensity,
                p.grayscale_mode, p.preview_channel, p.full_composite_preview
            )))

    def _on_channel_solo(self, channel: str, checked: bool):
        """Handle channel isolation for real-time preview"""
        if checked:
            # Solo this channel - uncheck others
            for ch, btn in self.channel_solo_buttons.items():
                if ch != channel:
                    btn.setChecked(False)
        
        # Update preview to show isolated channel
        self._mark_halftone_dirty()
        self._on_control_changed()

    # ===== UNDO / REDO SYSTEM =====

    def _snapshot_state(self) -> dict:
        """Capture the current UI + layer state as a lightweight dict for undo."""
        layers_snap = []
        for lay in self._layers:
            layers_snap.append({
                'name': lay.name,
                'visible': lay.visible,
                'offset_x': lay.offset_x,
                'offset_y': lay.offset_y,
                'scale_pct': lay.scale_pct,
                'opacity': lay.opacity,
                'effect_params': asdict(lay.effect_params) if lay.effect_params is not None else None,
            })
        return {
            'params': asdict(self.params()),
            'layers': layers_snap,
            'selected_layer': self._selected_layer_idx,
            'offset_x': self._offset_x,
            'offset_y': self._offset_y,
        }

    def _restore_snapshot(self, snap: dict):
        """Restore a previously captured snapshot dict to the UI + layer state."""
        self._restoring_params = True
        try:
            # Restore per-layer metadata (images stay as-is — only params change)
            for i, ls in enumerate(snap['layers']):
                if i >= len(self._layers):
                    break
                self._layers[i].visible = ls['visible']
                self._layers[i].offset_x = ls['offset_x']
                self._layers[i].offset_y = ls['offset_y']
                self._layers[i].scale_pct = ls['scale_pct']
                self._layers[i].opacity = ls['opacity']
                if ls['effect_params'] is not None:
                    # Filter out fields that aren't in the Params constructor
                    ep = ls['effect_params']
                    self._layers[i].effect_params = self._params_from_dict(ep)
                else:
                    self._layers[i].effect_params = None

            idx = snap.get('selected_layer', -1)
            if 0 <= idx < len(self._layers):
                self._selected_layer_idx = idx
            self._offset_x = snap.get('offset_x', 0)
            self._offset_y = snap.get('offset_y', 0)

            # Restore UI controls from the params snapshot
            p_dict = snap['params']
            p = self._params_from_dict(p_dict)
            self._apply_params_to_ui(p)
            # Registration must be restored explicitly since _apply_params_to_ui skips them
            self.regs_chk.setChecked(p.regs_on)
            self.reg_size_s.setValue(int(p.reg_size_px))
            self.reg_offset_s.setValue(int(p.reg_offset_px))
        finally:
            self._restoring_params = False
        self._sync_layer_list_widget()
        self._rebuild_composite()
        self._mark_halftone_dirty()
        self.update_preview(force=True)

    def _auto_snapshot(self):
        """Timer callback: push current state onto undo stack (debounced)."""
        now = time.monotonic()
        if now - self._last_snapshot_time < 0.3:
            return  # deduplicate rapid-fire snapshots
        snap = self._snapshot_state()
        self._undo_stack.append(snap)
        self._redo_stack.clear()
        self._last_snapshot_time = now

    def _push_undo_now(self):
        """Immediately push an undo snapshot (e.g. before a destructive op)."""
        self._undo_timer.stop()
        self._undo_stack.append(self._snapshot_state())
        self._redo_stack.clear()
        self._last_snapshot_time = time.monotonic()

    def on_undo(self):
        if not self._undo_stack:
            self.statusBar().showMessage("nothing to undo")
            return
        # Save current state to redo
        self._redo_stack.append(self._snapshot_state())
        snap = self._undo_stack.pop()
        self._restore_snapshot(snap)
        self.statusBar().showMessage(f"undo  ({len(self._undo_stack)} left)")

    def on_redo(self):
        if not self._redo_stack:
            self.statusBar().showMessage("nothing to redo")
            return
        self._undo_stack.append(self._snapshot_state())
        snap = self._redo_stack.pop()
        self._restore_snapshot(snap)
        self.statusBar().showMessage(f"redo  ({len(self._redo_stack)} left)")

    # ===== SAVE / LOAD PROJECT =====

    def _params_to_dict(self, p: 'Params') -> dict:
        d = asdict(p)
        # Ensure flow path is serialisable
        if d.get('lines_flow_path'):
            d['lines_flow_path'] = [list(pt) for pt in d['lines_flow_path']]
        return d

    def _build_project_dict(self) -> dict:
        """Build serialisable project dictionary."""
        layers_data = []
        for lay in self._layers:
            ld: dict = {
                'name': lay.name,
                'visible': lay.visible,
                'offset_x': lay.offset_x,
                'offset_y': lay.offset_y,
                'scale_pct': lay.scale_pct,
                'opacity': lay.opacity,
                'effect_params': self._params_to_dict(lay.effect_params) if lay.effect_params else None,
            }
            # Store layer image as embedded base64 PNG
            import io, base64
            buf = io.BytesIO()
            lay.image.save(buf, format='PNG')
            ld['image_b64'] = base64.b64encode(buf.getvalue()).decode('ascii')
            layers_data.append(ld)
        return {
            'version': 2,
            'params': self._params_to_dict(self.params()),
            'layers': layers_data,
            'selected_layer': self._selected_layer_idx,
            'offset_x': self._offset_x,
            'offset_y': self._offset_y,
            'artboard_size': self.art_size.currentText(),
            'orientation': self._doc_orientation,
            'dpi': self._doc_dpi,
            'doc_width_in': self._doc_width_in,
            'doc_height_in': self._doc_height_in,
        }

    def _params_from_dict(self, data: dict) -> 'Params':
        merged = asdict(self._default_params())
        valid_fields = {f.name for f in fields(Params)}
        for key, value in data.items():
            if key in valid_fields:
                merged[key] = value
        if merged.get('lines_flow_path'):
            merged['lines_flow_path'] = [tuple(pt) for pt in merged['lines_flow_path']]
        return Params(**merged)

    def _default_filename_stem(self) -> str:
        """Derive a default filename stem from layers or project path."""
        if self._project_path:
            return os.path.splitext(os.path.basename(self._project_path))[0]
        if self._layers:
            return os.path.splitext(self._layers[0].name)[0]
        return "untitled"

    def _default_save_path(self, filename: str) -> str:
        if self._working_dir:
            return os.path.join(self._working_dir, filename)
        return filename

    def _on_set_working_dir(self):
        start = self._working_dir or ""
        folder = QFileDialog.getExistingDirectory(self, "set working folder", start)
        if folder:
            self._working_dir = folder
            self.statusBar().showMessage(f"working folder: {folder}")

    def on_save_project(self):
        if self._project_path:
            self._write_project(self._project_path)
        else:
            self.on_save_project_as()

    def on_save_project_as(self):
        default = self._default_save_path(self._default_filename_stem() + ".htg")
        path, _ = QFileDialog.getSaveFileName(self, "save project", default, "Halftone Project (*.htg)")
        if not path:
            return
        if not path.lower().endswith('.htg'):
            path += '.htg'
        self._write_project(path)

    def _write_project(self, path: str):
        try:
            data = self._build_project_dict()
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=1)
            self._project_path = path
            QMessageBox.information(self, "Saved", f"Project saved:\n{path}")
        except Exception as e:
            QMessageBox.critical(self, "save failed", str(e))

    def _auto_save_project(self):
        """Background auto-save: silently writes project if a path is set."""
        if self._project_path and self._layers:
            try:
                data = self._build_project_dict()
                with open(self._project_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=1)
                self.statusBar().showMessage(f"auto-saved: {os.path.basename(self._project_path)}")
            except Exception:
                pass  # silent fail for background auto-save

    def on_load_project(self):
        path, _ = QFileDialog.getOpenFileName(self, "load project", self._working_dir or "", "Halftone Project (*.htg)")
        if not path:
            return
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self._load_project_dict(data)
            self._project_path = path
            self.statusBar().showMessage(f"project loaded: {os.path.basename(path)}")
        except Exception as e:
            QMessageBox.critical(self, "load failed", str(e))

    def _load_project_dict(self, data: dict):
        import io, base64
        self._layers.clear()
        self._selected_layer_idx = -1
        self._suppress_apply_preview = True
        for ld in data.get('layers', []):
            img_bytes = base64.b64decode(ld['image_b64'])
            img = Image.open(io.BytesIO(img_bytes)).convert('RGBA')
            lay = Layer(
                name=ld['name'],
                image=img,
                visible=ld.get('visible', True),
                offset_x=ld.get('offset_x', 0),
                offset_y=ld.get('offset_y', 0),
                scale_pct=ld.get('scale_pct', 100),
                opacity=ld.get('opacity', 1.0),
            )
            ep = ld.get('effect_params')
            if ep is not None:
                lay.effect_params = self._params_from_dict(ep)
            self._layers.append(lay)
        self._selected_layer_idx = data.get('selected_layer', max(0, len(self._layers) - 1))

        # Restore artboard / document settings
        if 'doc_width_in' in data:
            self._doc_width_in = data['doc_width_in']
        if 'doc_height_in' in data:
            self._doc_height_in = data['doc_height_in']
        if 'orientation' in data:
            self._doc_orientation = data['orientation']
            self.orientation.blockSignals(True)
            self.orientation.setCurrentText(data['orientation'])
            self.orientation.blockSignals(False)
        if 'dpi' in data:
            self._doc_dpi = data['dpi']
            self.output_dpi_s.blockSignals(True)
            self.output_dpi_s.setValue(data['dpi'])
            self.output_dpi_s.blockSignals(False)
        # Sync hidden art_size combo for legacy compat
        if 'artboard_size' in data:
            self.art_size.blockSignals(True)
            self.art_size.setCurrentText(data['artboard_size'])
            self.art_size.blockSignals(False)
        elif 'doc_width_in' in data:
            custom_label = f"{self._doc_width_in}×{self._doc_height_in} in"
            if custom_label not in [self.art_size.itemText(i) for i in range(self.art_size.count())]:
                self.ART_SIZES[custom_label] = (self._doc_width_in, self._doc_height_in)
                self.art_size.addItem(custom_label)
            self.art_size.blockSignals(True)
            self.art_size.setCurrentText(custom_label)
            self.art_size.blockSignals(False)
        self._offset_x = data.get('offset_x', 0)
        self._offset_y = data.get('offset_y', 0)
        self._update_titles()

        # Restore UI params
        p_dict = data.get('params', {})
        if p_dict:
            p = self._params_from_dict(p_dict)
            self._apply_params_to_ui(p)
            self.regs_chk.setChecked(p.regs_on)
            self.reg_size_s.setValue(int(p.reg_size_px))
            self.reg_offset_s.setValue(int(p.reg_offset_px))

        self._sync_layer_list_widget()
        self._rebuild_composite()
        self.export_png_btn.setEnabled(bool(self._layers))
        self.export_svg_btn.setEnabled(bool(self._layers))
        self.export_pdf_btn.setEnabled(bool(self._layers))
        self.export_tiff_btn.setEnabled(bool(self._layers))
        self._art_cache.clear(); self._cmyk_cache.clear(); self._arr_cache.clear()
        self._layer_render_cache.clear(); self._preview_cache.clear()
        self._mark_halftone_dirty()
        self._suppress_apply_preview = False
        self._sync_scale_ui_to_selected_layer()
        self.update_preview(force=True)

    def _on_regs_changed(self):
        self._sync_registration_to_bg()
        if self._last_render_base_rgba is not None:
            p = self.params(); img = self._last_render_base_rgba.copy()
            if p.regs_on: img = self._paste_regmarks_bitmap(img, p)
            self._prev_pix = pil_to_qpixmap(img)
            if self.prev_lbl:
                self.prev_lbl.setPixmap(self._prev_pix)
                self.prev_lbl.update()
        else:
            self.update_preview(force=False)

    def _apply_diffusion_glitches(self, arr: np.ndarray, p, channel_idx: int = 0,
                                    all_channel_results: Optional[dict] = None) -> np.ndarray:
        """Apply diffusion-based glitch effects via modified error-diffusion dithering.
        
        This is called from _apply_dithering when glitch params are active, modifying
        how error diffusion works rather than post-processing coverage arrays.
        Returns the glitched array (already dithered).
        """
        # If no diffusion glitches active, return unchanged
        has_glitch = (p.broken_kernel > 0 or p.directional_bias > 0 or
                      p.error_overflow > 0 or p.diffusion_reset > 0)
        if not has_glitch:
            return arr
        
        result = arr.copy().astype(np.float32)
        h, w = result.shape
        intensity = p.diffusion_intensity if p.diffusion_enabled else 0.8
        levels = max(2, p.diffusion_levels if p.diffusion_enabled else 4)
        algo = p.diffusion_algorithm if p.diffusion_enabled else "floyd-steinberg"
        
        # --- Kernel selection ---
        kernels = {
            "floyd-steinberg": (
                [(0, 1, 7), (1, -1, 3), (1, 0, 5), (1, 1, 1)], 16),
            "jarvis-judice-ninke": (
                [(0,1,7),(0,2,5),
                 (1,-2,3),(1,-1,5),(1,0,7),(1,1,5),(1,2,3),
                 (2,-2,1),(2,-1,3),(2,0,5),(2,1,3),(2,2,1)], 48),
            "stucki": (
                [(0,1,8),(0,2,4),
                 (1,-2,2),(1,-1,4),(1,0,8),(1,1,4),(1,2,2),
                 (2,-2,1),(2,-1,2),(2,0,4),(2,1,2),(2,2,1)], 42),
            "burkes": (
                [(0,1,8),(0,2,4),
                 (1,-2,2),(1,-1,4),(1,0,8),(1,1,4),(1,2,2)], 32),
            "atkinson": (
                [(0,1,1),(0,2,1),
                 (1,-1,1),(1,0,1),(1,1,1),
                 (2,0,1)], 8),
        }
        if algo not in kernels:
            algo = "floyd-steinberg"
        offsets, divisor = kernels[algo]
        
        k_dy = np.array([o[0] for o in offsets], dtype=np.int32)
        k_dx = np.array([o[1] for o in offsets], dtype=np.int32)
        k_w  = np.array([o[2] for o in offsets], dtype=np.float32)
        
        # --- Broken Kernel: randomly corrupt kernel weights ---
        if p.broken_kernel > 0:
            rng = np.random.default_rng(42 + channel_idx)
            nk = len(k_w)
            for i in range(nk):
                if rng.random() < p.broken_kernel:
                    action = rng.integers(0, 3)
                    if action == 0:
                        k_w[i] = 0.0  # zero out
                    elif action == 1:
                        k_w[i] = -k_w[i]  # invert
                    else:
                        k_w[i] = np.float32(rng.random()) * k_w.max() * 2  # random value
            # Ensure at least one non-zero weight
            if np.sum(np.abs(k_w)) < 0.001:
                k_w[0] = 1.0
        
        # --- Directional Bias: push error in a preferred direction ---
        if p.directional_bias > 0:
            angle_rad = np.deg2rad(p.directional_bias_angle)
            bias_dx = np.cos(angle_rad)
            bias_dy = np.sin(angle_rad)
            nk = len(k_w)
            for i in range(nk):
                # Dot product of kernel offset direction with bias direction
                offset_mag = np.sqrt(float(k_dx[i])**2 + float(k_dy[i])**2)
                if offset_mag > 0:
                    dot = (float(k_dx[i]) * bias_dx + float(k_dy[i]) * bias_dy) / offset_mag
                    # Boost weights aligned with bias, suppress opposing
                    boost = 1.0 + dot * p.directional_bias * 5.0
                    k_w[i] *= np.float32(max(0.01, boost))
        
        # Normalize weights
        k_w = np.maximum(k_w, np.float32(0.001))
        f_divisor = np.float32(k_w.sum())
        f_intensity = np.float32(intensity)
        
        # --- Diffusion Reset: compute row boundaries where error buffer resets ---
        if p.diffusion_reset > 0:
            # Number of resets: 1 at minimum intensity, up to h/10 at max
            n_resets = max(1, int(p.diffusion_reset * h / 10))
            rng_reset = np.random.default_rng(77 + channel_idx)
            reset_rows = np.sort(rng_reset.choice(np.arange(2, h - 2), size=min(n_resets, h - 4), replace=False)).astype(np.int32)
        else:
            reset_rows = np.array([], dtype=np.int32)
        
        # --- Run the glitched diffusion loop ---
        f_overflow = np.float32(p.error_overflow)
        
        if HAS_NUMBA and _diffuse_loop_glitch_njit is not None:
            result = _diffuse_loop_glitch_njit(result, k_dy, k_dx, k_w, f_divisor,
                                                f_intensity, levels, f_overflow, reset_rows)
        else:
            # Pure-Python fallback with overflow and reset support
            step = 1.0 / (levels - 1)
            inv_step = 1.0 / step
            next_reset_idx = 0
            for y in range(h):
                # Diffusion reset
                if next_reset_idx < len(reset_rows) and y == reset_rows[next_reset_idx]:
                    result[y, :] = np.clip(result[y, :], 0.0, 1.0)
                    next_reset_idx += 1
                for x in range(w):
                    old_val = result[y, x]
                    if f_overflow > 0:
                        clamped = np.clip(old_val, 0.0, 1.0)
                        wrapped = old_val % 1.0
                        if wrapped < 0:
                            wrapped += 1.0
                        val = clamped * (1.0 - f_overflow) + wrapped * f_overflow
                    else:
                        val = np.clip(old_val, 0.0, 1.0)
                    new_val = round(val * inv_step) * step
                    result[y, x] = new_val
                    error = (old_val - new_val) * intensity
                    if error == 0:
                        continue
                    for ki in range(len(k_dy)):
                        ny, nx = y + int(k_dy[ki]), x + int(k_dx[ki])
                        if 0 <= ny < h and 0 <= nx < w:
                            result[ny, nx] += error * k_w[ki] / f_divisor
        
        return np.clip(result, 0.0, 1.0)

    def _apply_cross_channel_bleed(self, channel_arrays: dict, p) -> dict:
        """Leak error-diffusion residuals across CMYK channels for ink contamination effect.
        
        Args:
            channel_arrays: dict with keys 'c', 'm', 'y', 'k' containing float32 arrays
            p: Params with cross_channel_bleed intensity
            
        Returns:
            Modified dict of channel arrays.
        """
        if p.cross_channel_bleed <= 0:
            return channel_arrays
        
        channels = list(channel_arrays.keys())
        if len(channels) < 2:
            return channel_arrays
        
        bleed_strength = p.cross_channel_bleed * 0.3  # Scale to reasonable range
        
        # Compute residuals (difference from quantized) for each channel
        residuals = {}
        for ch in channels:
            arr = channel_arrays[ch]
            # Residual = what the dithering would spread as error
            levels = max(2, p.diffusion_levels if p.diffusion_enabled else 4)
            step = 1.0 / (levels - 1)
            quantized = np.round(np.clip(arr, 0, 1) / step) * step
            residuals[ch] = arr - quantized
        
        # Bleed scheme: each channel gets contamination from its neighbors
        # C->M, M->Y, Y->K, K->C (circular)
        bleed_map = {'c': 'm', 'm': 'y', 'y': 'k', 'k': 'c'}
        
        result = {}
        rng = np.random.default_rng(99)
        for ch in channels:
            source_ch = bleed_map.get(ch, channels[0])
            if source_ch in residuals:
                bleed = residuals[source_ch] * bleed_strength
                # Add spatial variation so it's not uniform
                h, w = bleed.shape
                noise = rng.random((max(1, h // 8), max(1, w // 8)), dtype=np.float32)
                from scipy.ndimage import zoom as _zoom
                try:
                    noise = _zoom(noise, (h / max(1, noise.shape[0]), w / max(1, noise.shape[1])), order=1)[:h, :w]
                except:
                    noise = np.ones_like(bleed)
                result[ch] = np.clip(channel_arrays[ch] + bleed * noise, 0.0, 1.0)
            else:
                result[ch] = channel_arrays[ch]
        
        return result

    def _apply_smear_drag(self, arr: np.ndarray, p, channel_idx: int = 0) -> np.ndarray:
        """Drag coverage through random bands to create melt/streak artifacts."""
        if p.smear_drag <= 0:
            return arr
        h, w = arr.shape
        out = arr.copy()
        vertical = p.smear_vertical
        max_shift = max(1, int(p.smear_length))
        band_span = max(2, p.block_shift_size // 2)
        rng = np.random.default_rng(701 + channel_idx)
        source = arr
        decay = np.linspace(1.0, 0.2, max_shift + 1, dtype=np.float32)
        apply_prob = min(1.0, 0.35 + p.smear_drag * 0.65)

        if vertical:
            for x0 in range(0, w, band_span):
                if rng.random() > apply_prob:
                    continue
                x1 = min(w, x0 + band_span)
                band = source[:, x0:x1]
                acc = band.copy()
                direction = -1 if rng.random() < 0.5 else 1
                for step in range(1, max_shift + 1):
                    if direction > 0:
                        # Equivalent to shifting with zero fill, without allocating a full temp array.
                        np.maximum(acc[step:, :], band[:-step, :] * decay[step], out=acc[step:, :])
                    else:
                        np.maximum(acc[:-step, :], band[step:, :] * decay[step], out=acc[:-step, :])
                out[:, x0:x1] = np.clip(band * (1.0 - 0.4 * p.smear_drag) + acc * (0.4 * p.smear_drag + 0.35), 0.0, 1.0)
        else:
            for y0 in range(0, h, band_span):
                if rng.random() > apply_prob:
                    continue
                y1 = min(h, y0 + band_span)
                band = source[y0:y1, :]
                acc = band.copy()
                direction = -1 if rng.random() < 0.5 else 1
                for step in range(1, max_shift + 1):
                    if direction > 0:
                        np.maximum(acc[:, step:], band[:, :-step] * decay[step], out=acc[:, step:])
                    else:
                        np.maximum(acc[:, :-step], band[:, step:] * decay[step], out=acc[:, :-step])
                out[y0:y1, :] = np.clip(band * (1.0 - 0.4 * p.smear_drag) + acc * (0.4 * p.smear_drag + 0.35), 0.0, 1.0)
        return out

    def _apply_macroblock_corruption(self, arr: np.ndarray, p, channel_idx: int = 0) -> np.ndarray:
        """Corrupt block regions with repeats, quantized crush, and dropout."""
        if p.macroblock_corrupt <= 0:
            return arr
        h, w = arr.shape
        bs = max(4, p.block_shift_size)
        out = arr.copy()
        rng = np.random.default_rng(911 + channel_idx)
        rows_blocks = max(1, math.ceil(h / bs))
        cols_blocks = max(1, math.ceil(w / bs))
        n_blocks = rows_blocks * cols_blocks
        n_affect = max(1, int(n_blocks * p.macroblock_corrupt))
        dropout_mix = float(np.clip(p.macroblock_dropout, 0.0, 1.0))
        indices = rng.choice(n_blocks, size=min(n_affect, n_blocks), replace=False)

        for index in indices:
            by = int(index // cols_blocks)
            bx = int(index % cols_blocks)
            y0 = by * bs
            x0 = bx * bs
            y1 = min(y0 + bs, h)
            x1 = min(x0 + bs, w)
            block = out[y0:y1, x0:x1]
            if block.size == 0:
                continue

            mode_roll = rng.random()
            if mode_roll < dropout_mix * 0.55:
                block *= rng.uniform(0.0, 0.25)
                continue

            if mode_roll < 0.55:
                sy = int(np.clip(by + rng.integers(-2, 3), 0, rows_blocks - 1)) * bs
                sx = int(np.clip(bx + rng.integers(-2, 3), 0, cols_blocks - 1)) * bs
                src = arr[sy:min(sy + (y1 - y0), h), sx:min(sx + (x1 - x0), w)]
                oh = min(block.shape[0], src.shape[0])
                ow = min(block.shape[1], src.shape[1])
                if oh > 0 and ow > 0:
                    block[:oh, :ow] = src[:oh, :ow]
                continue

            if mode_roll < 0.82:
                levels = int(rng.integers(2, 6))
                step = 1.0 / max(1, levels - 1)
                block[:] = np.round(np.clip(block, 0.0, 1.0) / step) * step
                continue

            shift = int(rng.integers(-bs, bs + 1))
            axis = 0 if rng.random() < 0.5 else 1
            block[:] = np.roll(block, shift, axis=axis)

        return np.clip(out, 0.0, 1.0)

    # ── Datamosh Effects ──────────────────────────────────────────────

    def _apply_block_shift(self, arr: np.ndarray, p, channel_idx: int = 0) -> np.ndarray:
        """Shift random macroblocks by random offsets — datamosh look (vectorized)."""
        if p.block_shift <= 0:
            return arr
        h, w = arr.shape
        bs = max(4, p.block_shift_size)
        out = arr.copy()
        rng = np.random.default_rng(42 + channel_idx)
        rows_blocks = max(1, h // bs)
        cols_blocks = max(1, w // bs)
        n_blocks = rows_blocks * cols_blocks
        n_shift = max(1, int(n_blocks * p.block_shift))
        indices = rng.choice(n_blocks, size=min(n_shift, n_blocks), replace=False)
        # Vectorized: compute all block coords and offsets at once
        by_arr = indices // cols_blocks
        bx_arr = indices % cols_blocks
        y0s = by_arr * bs
        x0s = bx_arr * bs
        dys = rng.integers(-bs * 2, bs * 2 + 1, size=len(indices))
        dxs = rng.integers(-bs * 2, bs * 2 + 1, size=len(indices))
        for i in range(len(indices)):
            y0, x0 = int(y0s[i]), int(x0s[i])
            y1, x1 = min(y0 + bs, h), min(x0 + bs, w)
            dy, dx = int(dys[i]), int(dxs[i])
            sy0 = max(0, y0 + dy); sx0 = max(0, x0 + dx)
            sy1 = min(h, y1 + dy); sx1 = min(w, x1 + dx)
            oh = min(y1 - y0, sy1 - sy0); ow = min(x1 - x0, sx1 - sx0)
            if oh > 0 and ow > 0:
                out[y0:y0 + oh, x0:x0 + ow] = arr[sy0:sy0 + oh, sx0:sx0 + ow]
        return out

    def _apply_channel_desync(self, channel_arrays: dict, p) -> dict:
        """Independently shift each CMYK channel's blocks for channel desync."""
        if p.channel_desync <= 0:
            return channel_arrays
        result = {}
        for i, (ch, arr) in enumerate(channel_arrays.items()):
            h, w = arr.shape
            bs = max(4, p.block_shift_size)
            rng = np.random.default_rng(1337 + i * 7)
            # Per-channel random translation of entire array
            max_shift = int(p.channel_desync * bs * 2)
            if max_shift < 1:
                result[ch] = arr
                continue
            dy = int(rng.integers(-max_shift, max_shift + 1))
            dx = int(rng.integers(-max_shift, max_shift + 1))
            out = np.zeros_like(arr)
            # Compute overlap
            src_y0 = max(0, -dy)
            src_x0 = max(0, -dx)
            dst_y0 = max(0, dy)
            dst_x0 = max(0, dx)
            copy_h = h - abs(dy)
            copy_w = w - abs(dx)
            if copy_h > 0 and copy_w > 0:
                out[dst_y0:dst_y0 + copy_h, dst_x0:dst_x0 + copy_w] = arr[src_y0:src_y0 + copy_h, src_x0:src_x0 + copy_w]
            result[ch] = out
        return result

    def _apply_bitmap_sort(self, arr: np.ndarray, p, channel_idx: int = 0) -> np.ndarray:
        """Sort pixels by brightness within random bands — pixel-sort datamosh (vectorized run detection)."""
        if p.bitmap_sort <= 0:
            return arr
        out = arr.copy()
        h, w = arr.shape
        vertical = p.bitmap_sort_vertical
        # Keep channel-specific randomness so bitmap sort affects every CMYK plate distinctly.
        rng = np.random.default_rng(99 + int(channel_idx) * 17)
        n_lines = w if vertical else h
        n_affected = max(1, int(n_lines * p.bitmap_sort))
        line_indices = rng.choice(n_lines, size=min(n_affected, n_lines), replace=False)
        threshold = np.float32(0.1)
        for li in line_indices:
            li = int(li)
            line = out[:, li].copy() if vertical else out[li, :].copy()
            above = line > threshold
            # Vectorized run detection using diff
            padded = np.empty(len(above) + 2, dtype=np.bool_)
            padded[0] = False; padded[-1] = False; padded[1:-1] = above
            diffs = np.diff(padded.view(np.int8))
            starts = np.where(diffs == 1)[0]
            ends = np.where(diffs == -1)[0]
            for s, e in zip(starts, ends):
                line[s:e] = np.sort(line[s:e])
            if vertical:
                out[:, li] = line
            else:
                out[li, :] = line
        return out

    def _apply_slice_shift(self, arr: np.ndarray, p: Params) -> np.ndarray:
        if p.slice_shift_amt == 0: return arr
        h, w = arr.shape
        out = arr.copy().astype(np.float32)
        slice_size = max(2, getattr(p, 'slice_size_px', max(2, h // 50)))
        angle = float(getattr(p, 'slice_angle', 0.0))
        max_shift = p.slice_shift_amt
        if abs(angle) > 0.5 and HAS_SCIPY and nd_rotate is not None:
            rotated = nd_rotate(out, angle, reshape=False, mode='constant', cval=0.0)
            rh, rw = rotated.shape
            for y_start in range(0, rh, slice_size):
                y_end = min(y_start + slice_size, rh)
                shift_amt = np.random.randint(-max_shift, max_shift + 1)
                if shift_amt == 0: continue
                rotated[y_start:y_end, :] = np.roll(rotated[y_start:y_end, :], shift_amt, axis=1)
            out = nd_rotate(rotated, -angle, reshape=False, mode='constant', cval=0.0)
        else:
            for y_start in range(0, h, slice_size):
                y_end = min(y_start + slice_size, h)
                shift_amt = np.random.randint(-max_shift, max_shift + 1)
                if shift_amt == 0: continue
                out[y_start:y_end, :] = np.roll(out[y_start:y_end, :], shift_amt, axis=1)
        return np.clip(out, 0.0, 1.0)

    def _apply_vertical_slice_shift(self, arr: np.ndarray, p: Params) -> np.ndarray:
        """Apply vertical slice shift effect - shifts vertical slices up/down randomly"""
        if p.vertical_slice_shift_amt == 0: return arr
        h, w = arr.shape
        out = arr.copy().astype(np.float32)
        slice_size = max(2, getattr(p, 'vertical_slice_size_px', max(2, w // 50)))
        angle = float(getattr(p, 'vertical_slice_angle', 0.0))
        max_shift = p.vertical_slice_shift_amt
        if abs(angle) > 0.5 and HAS_SCIPY and nd_rotate is not None:
            rotated = nd_rotate(out, angle, reshape=False, mode='constant', cval=0.0)
            rh, rw = rotated.shape
            for x_start in range(0, rw, slice_size):
                x_end = min(x_start + slice_size, rw)
                shift_amt = np.random.randint(-max_shift, max_shift + 1)
                if shift_amt == 0: continue
                rotated[:, x_start:x_end] = np.roll(rotated[:, x_start:x_end], shift_amt, axis=0)
            out = nd_rotate(rotated, -angle, reshape=False, mode='constant', cval=0.0)
        else:
            for x_start in range(0, w, slice_size):
                x_end = min(x_start + slice_size, w)
                shift_amt = np.random.randint(-max_shift, max_shift + 1)
                if shift_amt == 0: continue
                out[:, x_start:x_end] = np.roll(out[:, x_start:x_end], shift_amt, axis=0)
        return np.clip(out, 0.0, 1.0)

    def _apply_halftone_slice_shift(self, arr: np.ndarray, p: Params) -> np.ndarray:
        """Apply horizontal fraying to left/right edges of image"""
        if p.halftone_slice_shift_amt == 0: return arr
        h, w = arr.shape
        
        # Find actual image content boundaries
        content_mask = arr > 0.1
        content_rows = np.any(content_mask, axis=1)
        content_cols = np.any(content_mask, axis=0)
        
        if not np.any(content_rows) or not np.any(content_cols):
            return arr
        
        top_idx = np.where(content_rows)[0][0]
        bottom_idx = np.where(content_rows)[0][-1]
        left_idx = np.where(content_cols)[0][0]
        right_idx = np.where(content_cols)[0][-1]
        
        out = arr.copy()
        max_shift = int(p.halftone_slice_shift_amt * 1.5)
        fray_width = max(10, max_shift * 2)
        n_rows = bottom_idx - top_idx + 1
        
        # Vectorized left-edge fraying
        insets_l = np.random.randint(0, max_shift + 1, size=n_rows)
        cut_xs_l = left_idx + insets_l
        valid_l = (cut_xs_l < left_idx + fray_width) & (cut_xs_l > left_idx)
        col_idx = np.arange(w)
        for rel_y in np.nonzero(valid_l)[0]:
            y = top_idx + rel_y
            out[y, left_idx:cut_xs_l[rel_y]] = 0.0
        
        # Vectorized right-edge fraying
        insets_r = np.random.randint(0, max_shift + 1, size=n_rows)
        cut_xs_r = right_idx - insets_r
        valid_r = (cut_xs_r > right_idx - fray_width) & (cut_xs_r < right_idx)
        for rel_y in np.nonzero(valid_r)[0]:
            y = top_idx + rel_y
            out[y, cut_xs_r[rel_y]:right_idx + 1] = 0.0
        
        return out

    def _apply_halftone_vertical_slice_shift(self, arr: np.ndarray, p: Params) -> np.ndarray:
        """Apply vertical fraying to top/bottom edges of image"""
        if p.halftone_vertical_slice_shift_amt == 0: return arr
        h, w = arr.shape
        
        # Find actual image content boundaries
        content_mask = arr > 0.1
        content_rows = np.any(content_mask, axis=1)
        content_cols = np.any(content_mask, axis=0)
        
        if not np.any(content_rows) or not np.any(content_cols):
            return arr
        
        top_idx = np.where(content_rows)[0][0]
        bottom_idx = np.where(content_rows)[0][-1]
        left_idx = np.where(content_cols)[0][0]
        right_idx = np.where(content_cols)[0][-1]
        
        out = arr.copy()
        max_shift = int(p.halftone_vertical_slice_shift_amt * 1.5)
        fray_height = max(10, max_shift * 2)
        n_cols = right_idx - left_idx + 1
        
        # Vectorized top-edge fraying
        insets_t = np.random.randint(0, max_shift + 1, size=n_cols)
        cut_ys_t = top_idx + insets_t
        valid_t = (cut_ys_t < top_idx + fray_height) & (cut_ys_t > top_idx)
        for rel_x in np.nonzero(valid_t)[0]:
            x = left_idx + rel_x
            out[top_idx:cut_ys_t[rel_x], x] = 0.0
        
        # Vectorized bottom-edge fraying
        insets_b = np.random.randint(0, max_shift + 1, size=n_cols)
        cut_ys_b = bottom_idx - insets_b
        valid_b = (cut_ys_b > bottom_idx - fray_height) & (cut_ys_b < bottom_idx)
        for rel_x in np.nonzero(valid_b)[0]:
            x = left_idx + rel_x
            out[cut_ys_b[rel_x]:bottom_idx + 1, x] = 0.0
        
        return out

    def _maybe_dither_arr(self, arr: np.ndarray, p: 'Params', channel_idx: int = 0) -> np.ndarray:
        """Apply error-diffusion dithering if enabled, or diffusion glitches if active."""
        has_diffusion_glitch = (p.broken_kernel > 0 or p.directional_bias > 0 or
                                p.error_overflow > 0 or p.diffusion_reset > 0)
        
        if not (p.diffusion_enabled and p.diffusion_intensity > 0) and not has_diffusion_glitch:
            return arr

        h, w = arr.shape
        
        # If diffusion glitches are active (even without diffusion_enabled), use glitch path
        if has_diffusion_glitch:
            if not HAS_NUMBA:
                max_pixels = 1_500_000
                if h * w > max_pixels:
                    scale = min(1.0, np.sqrt(max_pixels / (h * w)))
                    small_h, small_w = int(h * scale), int(w * scale)
                    if small_h > 0 and small_w > 0:
                        small_arr = np.array(Image.fromarray(arr).resize((small_w, small_h), Image.Resampling.LANCZOS))
                        glitched = self._apply_diffusion_glitches(small_arr, p, channel_idx)
                        return np.array(Image.fromarray(glitched).resize((w, h), Image.Resampling.NEAREST))
            return self._apply_diffusion_glitches(arr, p, channel_idx)

        # Standard diffusion path
        if not HAS_NUMBA:
            max_pixels = 1_500_000
            if h * w > max_pixels:
                scale = min(1.0, np.sqrt(max_pixels / (h * w)))
                small_h, small_w = int(h * scale), int(w * scale)
                if small_h > 0 and small_w > 0:
                    small_arr = np.array(Image.fromarray(arr).resize((small_w, small_h), Image.Resampling.LANCZOS))
                    dithered_small = self._apply_dithering(small_arr, p)
                    return np.array(Image.fromarray(dithered_small).resize((w, h), Image.Resampling.NEAREST))

        return self._apply_dithering(arr, p)

    def _apply_dithering(self, arr: np.ndarray, p: 'Params') -> np.ndarray:
        """Error-diffusion dithering with pre/post processing."""
        result = arr.copy().astype(np.float32)
        h, w = result.shape
        intensity = p.diffusion_intensity
        levels = max(2, p.diffusion_levels)

        # --- Pre-processing: denoise / add noise ---
        denoise_val = p.diffusion_denoise  # -1..+1
        if denoise_val != 0 and HAS_SCIPY and gaussian_filter is not None:
            if denoise_val < 0:
                # Negative = denoise (gaussian blur)
                sigma = abs(denoise_val) * 3.0
                result = gaussian_filter(result, sigma=sigma)
            else:
                # Positive = add noise
                rng = np.random.default_rng(42)
                noise = rng.normal(0, denoise_val * 0.3, result.shape).astype(np.float32)
                result = np.clip(result + noise, 0.0, 1.0)

        # --- Check for standalone modulation (algorithm == 'none') ---
        algo = p.diffusion_algorithm
        mod_type = getattr(p, 'diffusion_modulation', 'none')
        mod_str  = getattr(p, 'diffusion_mod_strength', 0.0)

        if algo == 'none':
            # No error diffusion — pure threshold / ordered dithering
            step = np.float32(1.0 / (levels - 1))
            if mod_type != 'none' and mod_str > 0:
                tmap = self._build_modulation_threshold(h, w, mod_type, mod_str)
                biased = result + tmap
                result = np.round(np.clip(biased, 0.0, 1.0) / step) * step
            else:
                result = np.round(np.clip(result, 0.0, 1.0) / step) * step
            result = np.clip(result, 0.0, 1.0)
            # Post-processing: unsharp-mask sharpen
            if p.diffusion_sharpen_strength > 0 and HAS_SCIPY and gaussian_filter is not None:
                blurred = gaussian_filter(result, sigma=p.diffusion_sharpen_radius)
                result = np.clip(result + (result - blurred) * p.diffusion_sharpen_strength * 3.0, 0.0, 1.0)
            return result

        # --- Error-diffusion kernel selection ---
        kernels = {
            "floyd-steinberg": (
                [(0, 1, 7), (1, -1, 3), (1, 0, 5), (1, 1, 1)], 16),
            "jarvis-judice-ninke": (
                [(0,1,7),(0,2,5),
                 (1,-2,3),(1,-1,5),(1,0,7),(1,1,5),(1,2,3),
                 (2,-2,1),(2,-1,3),(2,0,5),(2,1,3),(2,2,1)], 48),
            "stucki": (
                [(0,1,8),(0,2,4),
                 (1,-2,2),(1,-1,4),(1,0,8),(1,1,4),(1,2,2),
                 (2,-2,1),(2,-1,2),(2,0,4),(2,1,2),(2,2,1)], 42),
            "burkes": (
                [(0,1,8),(0,2,4),
                 (1,-2,2),(1,-1,4),(1,0,8),(1,1,4),(1,2,2)], 32),
            "atkinson": (
                [(0,1,1),(0,2,1),
                 (1,-1,1),(1,0,1),(1,1,1),
                 (2,0,1)], 8),
        }

        if algo not in kernels:
            algo = "floyd-steinberg"
        offsets, divisor = kernels[algo]

        # --- Build kernel numpy arrays for Numba / fallback ---
        k_dy = np.array([o[0] for o in offsets], dtype=np.int32)
        k_dx = np.array([o[1] for o in offsets], dtype=np.int32)
        k_w  = np.array([o[2] for o in offsets], dtype=np.float32)
        f_divisor = np.float32(divisor)
        f_intensity = np.float32(intensity)

        # --- Modulate kernel weights based on modulation type ---
        # Changes the DIRECTION error propagates, creating textural patterns
        if mod_type != 'none' and mod_str > 0:
            w_mod = k_w.copy()
            nk = len(k_dy)
            if mod_type == 'column':
                # Boost vertical neighbors (dx==0), reduce horizontal → vertical grain
                for i in range(nk):
                    if k_dx[i] == 0:
                        w_mod[i] *= np.float32(1.0 + mod_str * 5.0)
                    else:
                        w_mod[i] *= np.float32(max(0.01, 1.0 - mod_str * 0.9))
            elif mod_type == 'row':
                # Boost horizontal neighbors (dy==0), reduce vertical → horizontal grain
                for i in range(nk):
                    if k_dy[i] == 0:
                        w_mod[i] *= np.float32(1.0 + mod_str * 5.0)
                    else:
                        w_mod[i] *= np.float32(max(0.01, 1.0 - mod_str * 0.9))
            elif mod_type == 'dispersed':
                # Equalize all weights → even, scattered dot placement
                avg = w_mod.mean()
                w_mod = w_mod + (avg - w_mod) * np.float32(mod_str)
            elif mod_type == 'medium':
                # Partial equalization → moderately scattered
                avg = w_mod.mean()
                w_mod = w_mod + (avg - w_mod) * np.float32(mod_str * 0.5)
            elif mod_type == 'heavy':
                # Concentrate error to the single dominant neighbor
                max_idx = int(np.argmax(w_mod))
                target = np.zeros_like(w_mod)
                target[max_idx] = w_mod.sum()
                w_mod = w_mod + (target - w_mod) * np.float32(mod_str)
            elif mod_type == 'circuit':
                # Boost axis-aligned only (pure horiz OR vert), reduce diagonals
                for i in range(nk):
                    is_axis = (k_dx[i] == 0) != (k_dy[i] == 0)  # XOR
                    if is_axis:
                        w_mod[i] *= np.float32(1.0 + mod_str * 4.0)
                    else:
                        w_mod[i] *= np.float32(max(0.01, 1.0 - mod_str * 0.8))
            elif mod_type == 'tilt':
                # Boost diagonal neighbors, reduce axis-aligned → diagonal grain
                for i in range(nk):
                    if abs(k_dx[i]) > 0 and abs(k_dy[i]) > 0:
                        w_mod[i] *= np.float32(1.0 + mod_str * 5.0)
                    else:
                        w_mod[i] *= np.float32(max(0.01, 1.0 - mod_str * 0.7))
            elif mod_type == 'grid':
                # Boost far neighbors (manhattan dist >= 2), reduce close → crosshatch
                for i in range(nk):
                    dist = abs(int(k_dy[i])) + abs(int(k_dx[i]))
                    if dist >= 2:
                        w_mod[i] *= np.float32(1.0 + mod_str * 4.0)
                    else:
                        w_mod[i] *= np.float32(max(0.01, 1.0 - mod_str * 0.6))
            # Apply modified weights
            w_mod = np.maximum(w_mod, np.float32(0.001))
            k_w = w_mod
            f_divisor = np.float32(k_w.sum())

        if HAS_NUMBA and _diffuse_loop_njit is not None:
            result = _diffuse_loop_njit(result, k_dy, k_dx, k_w, f_divisor, f_intensity, levels)
        else:
            # Pure-Python fallback (uses modified kernel arrays)
            step = 1.0 / (levels - 1)
            for y in range(h):
                for x in range(w):
                    old_val = result[y, x]
                    new_val = round(np.clip(old_val, 0.0, 1.0) / step) * step
                    result[y, x] = new_val
                    error = (old_val - new_val) * intensity
                    if error == 0:
                        continue
                    for ki in range(len(k_dy)):
                        ny, nx = y + int(k_dy[ki]), x + int(k_dx[ki])
                        if 0 <= ny < h and 0 <= nx < w:
                            result[ny, nx] += error * k_w[ki] / f_divisor

        result = np.clip(result, 0.0, 1.0)

        # --- Post-processing: unsharp-mask sharpen ---
        if p.diffusion_sharpen_strength > 0 and HAS_SCIPY and gaussian_filter is not None:
            blurred = gaussian_filter(result, sigma=p.diffusion_sharpen_radius)
            result = np.clip(result + (result - blurred) * p.diffusion_sharpen_strength * 3.0, 0.0, 1.0)

        return result

    # ------------------------------------------------------------------
    # Standalone modulation threshold maps (ordered dithering patterns)
    # ------------------------------------------------------------------
    def _build_modulation_threshold(self, h: int, w: int, mod_type: str, strength: float) -> np.ndarray:
        """Generate a threshold offset map for standalone modulation (no error diffusion).

        Returns a float32 array of shape (h, w) with values in [-amp, +amp]
        that biases quantisation thresholds, producing ordered-dither patterns.
        """
        amplitude = np.float32(strength * 0.5)
        xs = np.arange(w, dtype=np.float32)
        ys = np.arange(h, dtype=np.float32)

        if mod_type == 'column':
            # Column-sequential sawtooth — vertical grain
            period = 8
            col = (xs % period) / period - 0.5
            tmap = np.broadcast_to(col[np.newaxis, :], (h, w)).copy()

        elif mod_type == 'row':
            # Row-sequential sawtooth — horizontal grain
            period = 8
            row = (ys % period) / period - 0.5
            tmap = np.broadcast_to(row[:, np.newaxis], (h, w)).copy()

        elif mod_type == 'dispersed':
            # 8×8 Bayer dispersed-dot ordered dither
            bayer = np.array([[0, 2], [3, 1]], dtype=np.float32)
            for _ in range(2):                       # expand 2→4→8
                n = bayer.shape[0]
                big = np.zeros((2 * n, 2 * n), dtype=np.float32)
                big[:n, :n] = 4 * bayer
                big[:n, n:] = 4 * bayer + 2
                big[n:, :n] = 4 * bayer + 3
                big[n:, n:] = 4 * bayer + 1
                bayer = big
            bayer = bayer / 64.0 - 0.5
            tmap = np.tile(bayer, (h // 8 + 1, w // 8 + 1))[:h, :w]

        elif mod_type == 'medium':
            # 4×4 clustered-dot matrix — moderate clustering
            m = np.array([
                [ 0, 8, 2, 10],
                [12, 4, 14,  6],
                [ 3, 11, 1,  9],
                [15, 7, 13,  5],
            ], dtype=np.float32) / 16.0 - 0.5
            tmap = np.tile(m, (h // 4 + 1, w // 4 + 1))[:h, :w]

        elif mod_type == 'heavy':
            # 8×8 clustered-dot — heavy clustering (centre-weighted spiral)
            m = np.array([
                [24, 10, 12, 26, 35, 47, 49, 37],
                [ 8,  0,  2, 14, 45, 59, 61, 51],
                [22,  6,  4, 16, 43, 57, 63, 53],
                [30, 20, 18, 28, 33, 41, 55, 39],
                [34, 46, 48, 36, 25, 11, 13, 27],
                [44, 58, 60, 50,  9,  1,  3, 15],
                [42, 56, 62, 52, 23,  7,  5, 17],
                [32, 40, 54, 38, 31, 21, 19, 29],
            ], dtype=np.float32) / 64.0 - 0.5
            tmap = np.tile(m, (h // 8 + 1, w // 8 + 1))[:h, :w]

        elif mod_type == 'circuit':
            # Alternating horiz / vert bars in 8-row bands
            xm = (xs % 8) / 8.0
            ym = (ys % 8) / 8.0
            tmap = np.where(
                (ys[:, np.newaxis] % 16) < 8,
                np.broadcast_to(xm[np.newaxis, :], (h, w)),
                np.broadcast_to(ym[:, np.newaxis], (h, w))
            ).astype(np.float32) - 0.5

        elif mod_type == 'tilt':
            # Diagonal sawtooth — 45° grain
            diag = (xs[np.newaxis, :] + ys[:, np.newaxis]) % 8
            tmap = (diag / 8.0 - 0.5).astype(np.float32)

        elif mod_type == 'grid':
            # Cross-hatch: max of column and row ramps
            cx = (xs % 8) / 8.0
            cy = (ys % 8) / 8.0
            tmap = (np.maximum(
                np.broadcast_to(cx[np.newaxis, :], (h, w)),
                np.broadcast_to(cy[:, np.newaxis], (h, w))
            ) - 0.5).astype(np.float32)

        else:
            tmap = np.zeros((h, w), dtype=np.float32)

        return tmap * amplitude

    def _get_noise_map(self, w: int, h: int, scale: float, seed: int) -> np.ndarray:
        key = (w, h, round(scale, 2), seed)
        if key in self._noise_cache: 
            return self._noise_cache[key]
            
        rng = np.random.default_rng(seed)
        
        # Make scale have a more visible effect on noise pattern
        scale_factor = scale / 100.0  # Convert percentage to decimal
        noise_size = max(2, int(min(w, h) * scale_factor / 5))
        low_w = max(2, int(noise_size * w / min(w, h)))
        low_h = max(2, int(noise_size))
        
        rand_arr = rng.random((low_h, low_w)) * 2.0 - 1.0
        noise_img = Image.fromarray((rand_arr * 127.5 + 127.5).astype(np.uint8))
        noise_img = noise_img.resize((w, h), Image.Resampling.LANCZOS)
        noise_map = (np.asarray(noise_img, dtype=np.float32) / 127.5) - 1.0
        self._noise_cache[key] = noise_map
        return noise_map
    
    def _compute_path_angle_at_points(self, points_x: np.ndarray, points_y: np.ndarray, 
                                       path: List[Tuple[float, float]], 
                                       base_angle_deg: float = 0.0, 
                                       influence: float = 1.0) -> np.ndarray:
        """
        Compute angles for a set of grid points based on a user-drawn path.
        Uses smooth tangent interpolation for gradual angle transitions.
        
        Args:
            points_x: 1D array of x coordinates for grid points
            points_y: 1D array of y coordinates for grid points
            path: List of (x, y) points defining the flow path (in image coordinates)
            base_angle_deg: Fallback angle when path influence is < 100%
            influence: 0.0-1.0, how strongly the path affects the angle (vs base angle)
        
        Returns:
            1D numpy array of angles in degrees, same length as points_x
        """
        n_points = len(points_x)
        
        if len(path) < 2:
            return np.full(n_points, base_angle_deg, dtype=np.float32)
        
        # Pre-compute smooth tangent angles at each path point using wider window
        path_arr = np.array(path, dtype=np.float32)
        n_path = len(path_arr)
        tangent_angles = np.zeros(n_path, dtype=np.float32)
        
        # Use 3-point window for smooth tangent estimation
        window = 3
        for i in range(n_path):
            # Look ahead and behind for smooth tangent
            i_start = max(0, i - window)
            i_end = min(n_path - 1, i + window)
            
            dx = path_arr[i_end, 0] - path_arr[i_start, 0]
            dy = path_arr[i_end, 1] - path_arr[i_start, 1]
            
            if abs(dx) > 0.001 or abs(dy) > 0.001:
                tangent_angles[i] = math.degrees(math.atan2(dy, dx))
            elif i > 0:
                tangent_angles[i] = tangent_angles[i - 1]
        
        # Compute cumulative arc length for interpolation
        arc_length = np.zeros(n_path, dtype=np.float32)
        for i in range(1, n_path):
            dx = path_arr[i, 0] - path_arr[i-1, 0]
            dy = path_arr[i, 1] - path_arr[i-1, 1]
            arc_length[i] = arc_length[i-1] + math.sqrt(dx*dx + dy*dy)
        
        total_length = arc_length[-1] if arc_length[-1] > 0 else 1.0
        
        xs = points_x.astype(np.float32)
        ys = points_y.astype(np.float32)
        
        # Find nearest path point and interpolate angle
        min_dist = np.full(n_points, np.inf, dtype=np.float32)
        nearest_idx = np.zeros(n_points, dtype=np.int32)
        nearest_t = np.zeros(n_points, dtype=np.float32)  # Interpolation parameter
        
        # Check each segment
        for i in range(n_path - 1):
            p1 = path_arr[i]
            p2 = path_arr[i + 1]
            
            dx = p2[0] - p1[0]
            dy = p2[1] - p1[1]
            seg_len_sq = dx*dx + dy*dy
            
            if seg_len_sq < 0.001:
                continue
            
            # Project points onto segment
            px = xs - p1[0]
            py = ys - p1[1]
            t = np.clip((px * dx + py * dy) / (seg_len_sq + 1e-10), 0.0, 1.0)
            
            # Nearest point on segment
            nearest_x = p1[0] + t * dx
            nearest_y = p1[1] + t * dy
            
            # Distance to segment
            dist = np.sqrt((xs - nearest_x)**2 + (ys - nearest_y)**2)
            
            # Update where this segment is closer
            closer = dist < min_dist
            min_dist = np.where(closer, dist, min_dist)
            nearest_idx = np.where(closer, i, nearest_idx)
            nearest_t = np.where(closer, t, nearest_t)
        
        # Interpolate angles smoothly along path
        result_angles = np.zeros(n_points, dtype=np.float32)
        
        for j in range(n_points):
            idx = nearest_idx[j]
            t = nearest_t[j]
            
            # Get angles at segment endpoints
            angle1 = tangent_angles[idx]
            angle2 = tangent_angles[min(idx + 1, n_path - 1)]
            
            # Handle angle wraparound (e.g., -170 to 170 degrees)
            diff = angle2 - angle1
            if diff > 180:
                angle2 -= 360
            elif diff < -180:
                angle2 += 360
            
            # Interpolate angle along segment
            result_angles[j] = angle1 + t * (angle2 - angle1)
        
        # Handle extrapolation beyond path ends
        # Points before path start: use first tangent
        p_start = path_arr[0]
        dist_to_start = np.sqrt((xs - p_start[0])**2 + (ys - p_start[1])**2)
        
        # Check if point is "before" the path start
        if n_path >= 2:
            dir_x = path_arr[1, 0] - path_arr[0, 0]
            dir_y = path_arr[1, 1] - path_arr[0, 1]
            proj_start = (xs - p_start[0]) * dir_x + (ys - p_start[1]) * dir_y
            before_start = proj_start < 0
            result_angles = np.where(before_start, tangent_angles[0], result_angles)
        
        # Points after path end: use last tangent
        p_end = path_arr[-1]
        if n_path >= 2:
            dir_x = path_arr[-1, 0] - path_arr[-2, 0]
            dir_y = path_arr[-1, 1] - path_arr[-2, 1]
            proj_end = (xs - path_arr[-2, 0]) * dir_x + (ys - path_arr[-2, 1]) * dir_y
            seg_len_sq = dir_x*dir_x + dir_y*dir_y
            after_end = proj_end > seg_len_sq
            result_angles = np.where(after_end, tangent_angles[-1], result_angles)
        
        # Blend with base angle based on influence
        if influence < 1.0:
            base_rad = math.radians(base_angle_deg)
            path_rad = np.radians(result_angles)
            
            dx_base = math.cos(base_rad)
            dy_base = math.sin(base_rad)
            dx_path = np.cos(path_rad)
            dy_path = np.sin(path_rad)
            
            dx_blend = dx_base * (1 - influence) + dx_path * influence
            dy_blend = dy_base * (1 - influence) + dy_path * influence
            
            result_angles = np.degrees(np.arctan2(dy_blend, dx_blend))
        
        return result_angles.astype(np.float32)

    def _grid_iter(self, w: int, h: int, cell: float, angle_deg: float) -> np.ndarray:
        key = (w, h, round(float(cell), 2), round(float(angle_deg), 2))
        arr = self._grid_cache.get(key)
        if arr is None:
            th = math.radians(angle_deg)
            c, s = abs(math.cos(th)), abs(math.sin(th))
            eff_w = w*c + h*s; eff_h = w*s + h*c
            nx = max(1, int(math.ceil(eff_w/max(1e-6, cell))))
            ny = max(1, int(math.ceil(eff_h/max(1e-6, cell))))
            cx, cy = w/2, h/2; cos_t, sin_t = math.cos(th), math.sin(th)
            # Vectorized grid generation — replaces nested Python loop
            j_vals = np.arange(ny, dtype=np.float32)
            i_vals = np.arange(nx, dtype=np.float32)
            v_vals = (-eff_h/2) + (j_vals + 0.5) * cell
            u_vals = (-eff_w/2) + (i_vals + 0.5) * cell
            uu, vv = np.meshgrid(u_vals, v_vals)  # shape (ny, nx)
            _, jj = np.meshgrid(i_vals, j_vals)   # row indices
            xs = cx + uu * cos_t - vv * sin_t
            ys = cy + uu * sin_t + vv * cos_t
            mask = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
            arr = np.column_stack([
                xs[mask].ravel(),
                ys[mask].ravel(),
                jj[mask].ravel()
            ]).astype(np.float32)
            if arr.size == 0:
                arr = np.empty((0, 3), dtype=np.float32)
            self._grid_cache[key] = arr
        return arr

    def _maybe_bump_cell_for_preview(self, w, h, cell, angle_deg):
        th = math.radians(angle_deg); c, s = abs(math.cos(th)), abs(math.sin(th))
        eff_w = w*c + h*s; eff_h = w*s + h*c
        nx, ny = max(1, int(math.ceil(eff_w/max(1e-6, cell)))), max(1, int(math.ceil(eff_h/max(1e-6, cell))))
        total = nx * ny
        budget = GRID_BUDGET_PREVIEW
        if total > budget:
            f = math.sqrt(total / budget)
            return cell * f
        return cell

    def _render_generative_art_plate(self, arr: np.ndarray, p: Params, channel_idx: int = 0,
                                       show_progress: bool = False, preview_mode: bool = False) -> Image.Image:
        """
        Render generative art pattern instead of halftone dots.
        
        Args:
            arr: Coverage array (0-1, where 1 = full coverage)
            p: Parameters object
            channel_idx: Channel index (0=C, 1=M, 2=Y, 3=K) for per-channel variations
            show_progress: Show orange progress bar dialog
            preview_mode: Use faster settings for preview (fewer iterations)
        
        Returns:
            RGBA image with the generative pattern
        """
        h, w = arr.shape
        out = Image.new("RGBA", (w, h), (255, 255, 255, 0))
        dr = ImageDraw.Draw(out, 'RGBA')
        black = (0, 0, 0, 255)
        
        line_width = max(1, int(p.generative_line_width * 3))
        
        # Create progress dialog if requested
        progress = None
        if show_progress:
            mode_name = p.generative_mode.replace("-", " ").title()
            progress = create_orange_progress(self, f"Generating {mode_name}...", 100)
            progress.show()
            QApplication.processEvents()
        
        def update_progress(value):
            if progress and not progress.wasCanceled():
                progress.setValue(min(99, value))
                QApplication.processEvents()
        
        try:
            # Generate pattern based on mode
            if p.generative_mode == "flow fields":
                # Use image as influence if per_channel is off, otherwise generate unique flow
                influence_arr = arr if p.flow_image_influence > 0 else None
                lines = _generate_flow_field_lines(
                    w, h, p, 
                    arr=influence_arr, 
                    channel_seed=channel_idx * 12345 if p.generative_per_channel else 0,
                    progress_callback=update_progress if show_progress else None
                )
                
                # Draw flow field lines
                for line in lines:
                    if len(line) < 2:
                        continue
                    # Convert to integer tuples for PIL
                    points = [(int(x), int(y)) for x, y in line]
                    dr.line(points, fill=black, width=line_width)
                    
            elif p.generative_mode == "spirograph":
                lines = _generate_spirograph(
                    w, h, p,
                    channel_seed=channel_idx * 12345 if p.generative_per_channel else 0
                )
                
                # Draw spirograph curves with progress
                total_lines = len(lines)
                for idx, line in enumerate(lines):
                    if show_progress and idx % 2 == 0:
                        update_progress(int(idx * 100 / max(1, total_lines)))
                    if len(line) < 2:
                        continue
                    points = [(int(x), int(y)) for x, y in line]
                    # Draw as connected line segments
                    for i in range(len(points) - 1):
                        dr.line([points[i], points[i + 1]], fill=black, width=line_width)
                        
            elif p.generative_mode == "reaction-diffusion":
                # Generate reaction-diffusion pattern
                rd_array = _generate_reaction_diffusion(
                    w, h, p,
                    channel_seed=channel_idx * 12345 if p.generative_per_channel else 0,
                    use_gpu=p.rd_use_gpu and HAS_CUPY,
                    preview_mode=preview_mode,
                    progress_callback=update_progress if show_progress else None
                )
                
                # Convert to lines for vector-friendly output
                lines = _rd_to_contour_lines(rd_array, p)
                
                # Draw contour lines
                for line in lines:
                    if len(line) >= 2:
                        points = [(int(x), int(y)) for x, y in line]
                        dr.line(points, fill=black, width=line_width)
                
                # Also fill the pattern areas for raster preview
                # Create a filled version
                rd_mask = (rd_array > 0.5).astype(np.uint8) * 255
                mask_img = Image.fromarray(rd_mask)
                out.paste(black, (0, 0), mask_img)
                
            elif p.generative_mode == "geometric flow":
                # Generate geometric shapes along flow field
                influence_arr = arr if p.flow_image_influence > 0 else None
                shapes = _generate_geometric_flow(
                    w, h, p,
                    arr=influence_arr,
                    channel_seed=channel_idx * 12345 if p.generative_per_channel else 0,
                    progress_callback=update_progress if show_progress else None
                )
                
                # Check if using custom SVG shape
                use_custom = (p.geoflow_shape == "custom" and 
                             self.shape_paths is not None and 
                             self.shape_bbox is not None)
                
                for shape in shapes:
                    cx, cy = shape['cx'], shape['cy']
                    size = shape['size']
                    angle = shape['angle']
                    pts = shape['points']
                    
                    if use_custom:
                        # Draw custom SVG shape
                        self._draw_custom_shape_at(dr, cx, cy, size, angle, black, p.geoflow_fill, line_width)
                    elif pts and len(pts) > 0 and pts[0][0] == 'circle':
                        # Circle special case
                        _, ccx, ccy, radius = pts[0]
                        bbox = [int(ccx - radius), int(ccy - radius), 
                               int(ccx + radius), int(ccy + radius)]
                        if p.geoflow_fill:
                            dr.ellipse(bbox, fill=black)
                        else:
                            dr.ellipse(bbox, outline=black, width=line_width)
                    else:
                        # Polygon
                        int_points = [(int(x), int(y)) for x, y in pts]
                        if len(int_points) >= 3:
                            if p.geoflow_fill:
                                dr.polygon(int_points, fill=black)
                            else:
                                dr.polygon(int_points, outline=black, width=line_width)
        
        finally:
            if progress:
                progress.setValue(100)
                progress.close()
        
        return out

    def _draw_custom_shape_at(self, dr, cx: float, cy: float, size: float, angle: float, 
                               color, fill: bool, line_width: int):
        """Draw the loaded custom SVG shape at given position, size, and rotation"""
        if self.shape_paths is None or self.shape_bbox is None:
            return
            
        minx, miny, maxx, maxy = self.shape_bbox
        w0, h0 = maxx - minx, maxy - miny
        if max(w0, h0) < 1e-6:
            return
        scale = size / max(w0, h0)
        
        # Get path points and transform
        cos_a, sin_a = np.cos(angle), np.sin(angle)
        
        for path in self.shape_paths:
            # Sample points along the path
            points = []
            try:
                # Use path length approximation
                for t in np.linspace(0, 1, 50):
                    pt = path.point(t)
                    # Center, scale, rotate, translate
                    px = (pt.real - (minx + w0/2)) * scale
                    py = (pt.imag - (miny + h0/2)) * scale
                    rx = px * cos_a - py * sin_a + cx
                    ry = px * sin_a + py * cos_a + cy
                    points.append((int(rx), int(ry)))
            except:
                continue
            
            if len(points) >= 3:
                if fill:
                    dr.polygon(points, fill=color)
                else:
                    dr.polygon(points, outline=color, width=line_width)

    # ------------------------------------------------------------------
    #  CMYK Pixelate rendering
    # ------------------------------------------------------------------
    def _render_pixelate(self, cmyk_arrs: Dict[str, np.ndarray], p: 'Params') -> Image.Image:
        """Render CMYK pixelate as solid colour blocks (vectorized)."""
        h, w = cmyk_arrs['c'].shape
        block = max(2, p.pixelate_block_size)
        # Trim to exact multiples for reduceat, then handle remainder
        rows = np.arange(0, h, block)
        cols = np.arange(0, w, block)
        n_by, n_bx = len(rows), len(cols)
        # Block-average each channel using add.reduceat
        def _block_avg(a):
            # reduceat along rows, then cols
            s = np.add.reduceat(a, rows, axis=0)            # (n_by, w)
            s = np.add.reduceat(s, cols, axis=1)            # (n_by, n_bx)
            # Compute actual block sizes for correct averaging
            bh = np.diff(np.append(rows, h)).reshape(-1, 1)  # (n_by, 1)
            bw = np.diff(np.append(cols, w)).reshape(1, -1)  # (1, n_bx)
            return s / (bh * bw)
        c_blk = _block_avg(cmyk_arrs['c'])
        m_blk = _block_avg(cmyk_arrs['m'])
        y_blk = _block_avg(cmyk_arrs['y'])
        k_blk = _block_avg(cmyk_arrs['k'])
        # Subtractive CMYK → RGB per block
        inv_k = 1.0 - k_blk
        R_blk = np.clip((1.0 - c_blk) * inv_k * 255.0, 0, 255).astype(np.uint8)
        G_blk = np.clip((1.0 - m_blk) * inv_k * 255.0, 0, 255).astype(np.uint8)
        B_blk = np.clip((1.0 - y_blk) * inv_k * 255.0, 0, 255).astype(np.uint8)
        # Expand blocks back to full resolution using repeat
        bh_sizes = np.diff(np.append(rows, h))
        bw_sizes = np.diff(np.append(cols, w))
        R_full = np.repeat(np.repeat(R_blk, bh_sizes, axis=0), bw_sizes, axis=1)
        G_full = np.repeat(np.repeat(G_blk, bh_sizes, axis=0), bw_sizes, axis=1)
        B_full = np.repeat(np.repeat(B_blk, bh_sizes, axis=0), bw_sizes, axis=1)
        A_full = np.full((h, w), 255, dtype=np.uint8)
        rgba = np.dstack([R_full, G_full, B_full, A_full])
        return Image.fromarray(rgba)

    def _render_pixelate_channel(self, cmyk_arrs: Dict[str, np.ndarray],
                                  channel: str, p: 'Params') -> Image.Image:
        """Render a single CMYK channel's pixelate coverage as black on transparent.

        Each block is filled proportionally: the target channel gets a
        solid black strip whose width = coverage * block_width.
        Strips are laid out C→M→Y→K left-to-right (no overlap).
        """
        h, w = cmyk_arrs['c'].shape
        block = max(2, p.pixelate_block_size)

        out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        dr = ImageDraw.Draw(out)
        black = (0, 0, 0, 255)

        cmyk_order = ['c', 'm', 'y', 'k']

        for by in range(0, h, block):
            y1, y2 = by, min(by + block, h)
            for bx in range(0, w, block):
                x1, x2 = bx, min(bx + block, w)
                bw = x2 - x1
                if bw < 1 or y2 <= y1:
                    continue

                coverages = {ch: float(np.mean(cmyk_arrs[ch][y1:y2, x1:x2])) for ch in cmyk_order}

                # Allocate pixel widths proportional to coverage
                raw_widths = {ch: coverages[ch] * bw for ch in cmyk_order}
                widths = {ch: int(round(raw_widths[ch])) for ch in cmyk_order}
                # Clamp total to block width
                while sum(widths.values()) > bw:
                    mx = max(widths, key=lambda k: widths[k])
                    widths[mx] -= 1

                # Walk left→right, draw only the target channel's strip
                cursor_x = x1
                for ch in cmyk_order:
                    sw = widths[ch]
                    if sw <= 0:
                        cursor_x += sw
                        continue
                    strip_end = min(cursor_x + sw, x2)
                    if ch == channel and cursor_x < strip_end:
                        dr.rectangle([cursor_x, y1, strip_end - 1, y2 - 1], fill=black)
                    cursor_x = strip_end

        return out

    def _render_plate_from_arr(self, arr: np.ndarray, p: Params, angle: float, shape_override: Optional[str] = None, channel_idx: int = 0, exact_cell: bool = False) -> Image.Image:
        h, w = arr.shape
        
        # Check if ASCII art mode is enabled - render as ASCII instead of halftone
        if p.ascii_enabled:
            return self._render_ascii_art(arr, p)
        
        # For lines invert, invert only the image content areas
        # Transparent/white background areas (very low coverage) should remain white
        mode = shape_override or self._shape_id()
        if mode == "lines" and p.hatching_invert:
            # Define "content" as areas with actual coverage (> 0.02 threshold)
            # Areas below this threshold are considered transparent/white background
            content_threshold = 0.02
            content_mask = arr > content_threshold
            arr = arr.copy()
            # Invert: dark areas (high coverage) become light, light areas become dark
            # But only within the content region - background stays at 0
            arr[content_mask] = 1.0 - arr[content_mask]
            # Ensure background areas stay white (no lines) by setting to 0
            arr[~content_mask] = 0.0
        
        # Apply datamosh coverage effects
        if p.block_shift > 0:
            arr = self._apply_block_shift(arr, p, channel_idx)
        if p.bitmap_sort > 0:
            arr = self._apply_bitmap_sort(arr, p, channel_idx)
        
        # Apply padded halftone slice shifts early to allow edge fraying
        arr = self._apply_halftone_slice_shift(arr, p)
        arr = self._apply_halftone_vertical_slice_shift(arr, p)
        
        out = Image.new("RGBA", (w, h), (255, 255, 255, 0)); dr = ImageDraw.Draw(out, 'RGBA')
        black = (0, 0, 0, 255); tiny_dot_thresh = 0.05
        tiny_line_thresh = 0.10
        # Exports must honor the exact user-set halftone size; only preview may downscale the grid for speed.
        cell = p.cell if exact_cell else self._maybe_bump_cell_for_preview(w, h, p.cell, angle)
        
        # Dot gap is fixed at 0 (100% - no gap), element is fixed at 100%
        # This simplifies the effective element size calculation
        cell_spacing = cell  # Grid spacing stays constant
        elem_with_gap = p.elem  # No gap reduction needed since dot_gap is always 0
        
        # Define seed first
        pseed = 1234
        warp_noise = self._get_noise_map(w, h, p.warp_scale, pseed) if p.warp_amt > 0 else None
    
        grid_points = self._grid_iter(w, h, cell_spacing, angle)
        if not grid_points.any(): return out

        px, py = grid_points[:, 0].astype(int), grid_points[:, 1].astype(int)
        valid_indices = (px >= 0) & (px < w) & (py >= 0) & (py < h)

        if warp_noise is not None:
            offsets = warp_noise[py[valid_indices], px[valid_indices]] * p.warp_amt
            grid_points[valid_indices, 0] = np.clip(grid_points[valid_indices, 0] + offsets, 0.0, float(w - 1))
            grid_points[valid_indices, 1] = np.clip(grid_points[valid_indices, 1] + offsets, 0.0, float(h - 1))

        sizes = arr[py[valid_indices], px[valid_indices]]
        sizes = np.clip(sizes, 0.0, 1.0)

        if mode != "lines":
            # IMPROVED: Better gamma correction that preserves detail in light areas
            gamma = 1.8
            gamma_corrected_sizes = np.power(np.clip(sizes, 0.0, 1.0), 1.0 / gamma)
            radii = 0.5 * cell_spacing * elem_with_gap * gamma_corrected_sizes
            minimum_radius = 0.05
            valid_dots = radii > minimum_radius
            coords = grid_points[valid_indices][valid_dots]; final_radii = radii[valid_dots]

            # ── Fast circle rendering via OpenCV ──────────────────────
            use_cv_circles = (HAS_OPENCV and mode in ("circle", "dot"))
            if use_cv_circles:
                alpha = np.zeros((h, w), dtype=np.uint8)
                n = len(coords)
                # Vectorized diameter computation
                diameters = np.maximum(1, np.round(2 * final_radii).astype(np.int32))
                int_radii = np.maximum(1, diameters // 2)
                cx_arr = np.round(coords[:, 0]).astype(np.int32)
                cy_arr = np.round(coords[:, 1]).astype(np.int32)

                # Single-pixel dots for very small radii
                tiny_mask = diameters <= 2
                if np.any(tiny_mask):
                    tx = cx_arr[tiny_mask]
                    ty = cy_arr[tiny_mask]
                    valid_tiny = (tx >= 0) & (tx < w) & (ty >= 0) & (ty < h)
                    alpha[ty[valid_tiny], tx[valid_tiny]] = 255

                # Batch circles by radius — draw all same-radius circles together
                big_mask = ~tiny_mask
                if np.any(big_mask):
                    big_cx = cx_arr[big_mask]
                    big_cy = cy_arr[big_mask]
                    big_r = int_radii[big_mask]
                    unique_radii = np.unique(big_r)
                    assert cv2 is not None
                    if len(unique_radii) <= 64:
                        # Few unique radii: stamp circle templates via batch
                        for ur in unique_radii:
                            ur_int = int(ur)
                            d = ur_int * 2 + 1
                            tmpl = np.zeros((d, d), dtype=np.uint8)
                            cv2.circle(tmpl, (ur_int, ur_int), ur_int, 255, -1, cv2.LINE_AA)
                            rmask = big_r == ur
                            xs = big_cx[rmask]
                            ys = big_cy[rmask]
                            # Vectorized bounds for all dots of this radius
                            x1s_v = xs - ur_int
                            y1s_v = ys - ur_int
                            # Filter dots fully outside the image
                            keep = (x1s_v + d > 0) & (y1s_v + d > 0) & (x1s_v < w) & (y1s_v < h)
                            if not np.any(keep):
                                continue
                            x1s_v = x1s_v[keep]; y1s_v = y1s_v[keep]
                            # Fully-interior dots (no clipping needed) — fast path
                            interior = (x1s_v >= 0) & (y1s_v >= 0) & (x1s_v + d <= w) & (y1s_v + d <= h)
                            ix = x1s_v[interior]; iy = y1s_v[interior]
                            for j in range(len(ix)):
                                np.maximum(alpha[iy[j]:iy[j]+d, ix[j]:ix[j]+d], tmpl, out=alpha[iy[j]:iy[j]+d, ix[j]:ix[j]+d])
                            # Edge dots (need per-dot clipping) — slow path
                            edge_idx = np.where(~interior)[0]
                            for j in edge_idx:
                                x1 = int(x1s_v[j]); y1 = int(y1s_v[j])
                                sx = max(0, -x1); sy = max(0, -y1)
                                dx1 = max(0, x1); dy1 = max(0, y1)
                                dx2 = min(w, x1+d); dy2 = min(h, y1+d)
                                if dx2 > dx1 and dy2 > dy1:
                                    np.maximum(alpha[dy1:dy2, dx1:dx2], tmpl[sy:sy+(dy2-dy1), sx:sx+(dx2-dx1)], out=alpha[dy1:dy2, dx1:dx2])
                    else:
                        # Many unique radii: single cv2 call per dot
                        for i in range(len(big_cx)):
                            cv2.circle(alpha, (int(big_cx[i]), int(big_cy[i])),
                                       int(big_r[i]), 255, -1, cv2.LINE_AA)

                out_arr = np.zeros((h, w, 4), dtype=np.uint8)
                out_arr[:, :, 3] = alpha
                out = Image.fromarray(out_arr)
            else:
                # ── Numpy alpha-buffer compositing for non-circle shapes ──
                alpha = np.zeros((h, w), dtype=np.uint8)
                angle_int = int(round(angle))
                for (x, y, _), r in zip(coords, final_radii):
                    d = int(max(1, round(2*r)))
                    if d <= 2:
                        ix, iy = int(round(x)), int(round(y))
                        if 0 <= ix < w and 0 <= iy < h: alpha[iy, ix] = 255
                    else:
                        mask = self._get_rotated_mask(mode, angle_int, d, p)
                        mask_arr = np.asarray(mask)
                        mh, mw = mask_arr.shape[:2]
                        x1, y1 = int(round(x - r)), int(round(y - r))
                        # Clip to image bounds
                        sx = max(0, -x1); sy = max(0, -y1)
                        ox1 = max(0, x1); oy1 = max(0, y1)
                        ox2 = min(w, x1 + mw); oy2 = min(h, y1 + mh)
                        if ox2 > ox1 and oy2 > oy1:
                            rw, rh = ox2 - ox1, oy2 - oy1
                            region = mask_arr[sy:sy+rh, sx:sx+rw]
                            np.maximum(alpha[oy1:oy2, ox1:ox2], region, out=alpha[oy1:oy2, ox1:ox2])
                out_arr = np.zeros((h, w, 4), dtype=np.uint8)
                out_arr[:, :, 3] = alpha
                out = Image.fromarray(out_arr)
        elif mode == "lines":
            # ── Fast line rendering via OpenCV when available ──────────
            base_cell_spacing = cell_spacing * p.line_density_pct
            line_lengths = base_cell_spacing * elem_with_gap * sizes * (p.line_length_pct / 100.0)
            valid_lines = line_lengths > tiny_line_thresh
            coords = grid_points[valid_indices][valid_lines]
            final_lengths = line_lengths[valid_lines]
            
            base_width = max(1, int(round(p.stroke * p.line_width_pct)))
            
            use_flow_path = (p.lines_use_flow_path and 
                             p.lines_flow_path is not None and 
                             len(p.lines_flow_path) >= 2)
            point_angles = None
            if use_flow_path:
                flow_path = p.lines_flow_path
                assert flow_path is not None
                influence = p.lines_path_influence / 100.0
                point_angles = self._compute_path_angle_at_points(
                    coords[:, 0], coords[:, 1], flow_path, 
                    base_angle_deg=angle, influence=influence
                )
            
            th = math.radians(angle)
            ct, st = math.cos(th), math.sin(th)
            
            use_cv_lines = HAS_OPENCV and p.line_taper_pct <= 0 and p.line_weight_variation <= 0 and point_angles is None
            if use_cv_lines:
                # Fully vectorized line rendering with OpenCV
                alpha = np.zeros((h, w), dtype=np.uint8)
                half_L = final_lengths * 0.5
                cx_arr = coords[:, 0]; cy_arr = coords[:, 1]
                x1s = (cx_arr - half_L * ct).astype(np.int32)
                y1s = (cy_arr - half_L * st).astype(np.int32)
                x2s = (cx_arr + half_L * ct).astype(np.int32)
                y2s = (cy_arr + half_L * st).astype(np.int32)
                assert cv2 is not None
                # Batch all line segments into a single cv2.polylines call
                n = len(coords)
                if n > 0:
                    for j in range(n):
                        cv2.line(alpha,
                                 (int(x1s[j]), int(y1s[j])),
                                 (int(x2s[j]), int(y2s[j])),
                                 255,
                                 base_width,
                                 cv2.LINE_AA)
                out_arr = np.zeros((h, w, 4), dtype=np.uint8)
                out_arr[:, :, 3] = alpha
                out = Image.fromarray(out_arr)
            else:
                # Fallback PIL path for taper / variable weight / flow path
                for i, ((x, y, _), L) in enumerate(zip(coords, final_lengths)):
                    if point_angles is not None:
                        local_th = math.radians(point_angles[i])
                        ct, st = math.cos(local_th), math.sin(local_th)
                    
                    if p.line_weight_variation > 0:
                        weight_factor = 1.0 + (np.random.random() - 0.5) * p.line_weight_variation * 2
                        line_width = max(1, int(base_width * weight_factor))
                    else:
                        line_width = base_width
                    
                    if p.line_taper_pct > 0:
                        segments = max(3, int(L / 5))
                        dx_total = L * ct / 2
                        dy_total = L * st / 2
                        for seg in range(segments):
                            seg_progress = seg / (segments - 1)
                            center_distance = abs(seg_progress - 0.5) * 2
                            taper_factor = 1.0 - (center_distance * p.line_taper_pct)
                            segment_width = max(1, int(line_width * taper_factor))
                            seg_x = x + dx_total * (seg_progress - 0.5) * 2
                            seg_y = y + dy_total * (seg_progress - 0.5) * 2
                            seg_length = L / segments * 1.2
                            seg_dx = seg_length * ct / 2
                            seg_dy = seg_length * st / 2
                            dr.line((seg_x - seg_dx, seg_y - seg_dy, 
                                    seg_x + seg_dx, seg_y + seg_dy), 
                                   fill=black, width=segment_width)
                    else:
                        dx = (L/2) * ct; dy = (L/2) * st
                        dr.line((x-dx, y-dy, x+dx, y+dy), fill=black, width=line_width)

        return out

    def _composite_from_cov(self, covC: np.ndarray, covM: np.ndarray, covY: np.ndarray, covK: np.ndarray) -> Image.Image:
        # Multiplicative (subtractive) CMYK-to-RGB — single-pass into reusable uint8 buffer
        h, w = covC.shape
        if self._composite_buf_shape != (h, w):
            self._composite_buf_shape = (h, w)
            self._composite_buf = np.empty((h, w), dtype=np.float32)
            self._composite_rgba = np.empty((h, w, 4), dtype=np.uint8)
        assert self._composite_buf is not None and self._composite_rgba is not None
        buf = cast(np.ndarray, self._composite_buf)
        rgba = cast(np.ndarray, self._composite_rgba)
        inv_k = (1.0 - covK).astype(np.float32)
        np.multiply((1.0 - covC), inv_k, out=buf); buf *= 255.0; np.clip(buf, 0, 255, out=buf); rgba[:, :, 0] = buf
        np.multiply((1.0 - covM), inv_k, out=buf); buf *= 255.0; np.clip(buf, 0, 255, out=buf); rgba[:, :, 1] = buf
        np.multiply((1.0 - covY), inv_k, out=buf); buf *= 255.0; np.clip(buf, 0, 255, out=buf); rgba[:, :, 2] = buf
        rgba[:, :, 3] = 255
        return Image.fromarray(rgba)

    def _update_moire_tile(self):
        p = self.params()
        p = replace(p, warp_amt=0, slice_shift_amt=0, vertical_slice_shift_amt=0,
                   broken_kernel=0, directional_bias=0, error_overflow=0, diffusion_reset=0, cross_channel_bleed=0,
                   block_shift=0, channel_desync=0, bitmap_sort=0)
        # Keep halftone slice shifts enabled for moire preview
        base_w, base_h = 200, 140
        if p.grayscale_mode:
            L = np.ones((base_h, base_w), dtype=np.float32)*0.4
            cov = (1.0 - L) if not p.invert_gray else L
            gamma = self._gamma_from_contrast(100)
            cov = np.clip(cov, 0, 1)**gamma
            plate = self._render_plate_from_arr(cov, p, p.ang_k)
            self.moire_lbl.setPixmap(pil_to_qpixmap(plate))
            return
        cov = np.ones((base_h, base_w), dtype=np.float32)*0.60
        ex = self._pool
        futs = {
            'c': ex.submit(self._render_plate_from_arr, cov, p, p.ang_c),
            'm': ex.submit(self._render_plate_from_arr, cov, p, p.ang_m),
            'y': ex.submit(self._render_plate_from_arr, cov, p, p.ang_y),
            'k': ex.submit(self._render_plate_from_arr, cov, p, p.ang_k)
        }
        plates = {ch: f.result() for ch, f in futs.items()}
        covs = {ch: np.asarray(plate.getchannel("A"), dtype=np.float32)/255.0 for ch, plate in plates.items()}
        comp = self._composite_from_cov(covs['c'], covs['m'], covs['y'], covs['k'])
        self.moire_lbl.setPixmap(pil_to_qpixmap(comp))

    def _paste_regmarks_bitmap(self, img: Image.Image, p: Params):
        if not p.regs_on: return img
        w, h = img.size; size = p.reg_size_px; off = p.reg_offset_px
        draw = ImageDraw.Draw(img, 'RGBA')
        base_t = max(2, int(round(size*0.06)))
        t = max(1, int(round(base_t * p.reg_thickness_pct)))
        half = size*0.5
        mc = self._reg_mark_color()
        for (ax, ay) in [(off,off),(w-off,off),(w-off,h-off),(off,h-off)]:
            draw.rectangle((ax-half, ay-half, ax+half, ay+half), outline=mc, width=t)
            draw.line((ax-half, ay, ax+half, ay), fill=mc, width=t)
            draw.line((ax, ay-half, ax, ay+half), fill=mc, width=t)
        return img

    def _apply_displacement(self, plates: Dict[str, Image.Image], p: Params) -> Dict[str, Image.Image]:
        # Fast path: skip entirely when no displacement is set on any channel
        if (p.displace_c == (0, 0) and p.displace_m == (0, 0) and
            p.displace_y == (0, 0) and p.displace_k == (0, 0)):
            return plates
        displaced_plates = {}
        for ch, plate_img in plates.items():
            dx, dy = {'c': p.displace_c, 'm': p.displace_m, 'y': p.displace_y, 'k': p.displace_k}[ch]
            if dx == 0 and dy == 0:
                displaced_plates[ch] = plate_img
                continue
            bounded = Image.new("RGBA", plate_img.size, (0, 0, 0, 0))
            bounded.paste(plate_img, (int(dx), int(dy)), plate_img)
            displaced_plates[ch] = bounded
        return displaced_plates

    def update_preview(self, force=False):
        p = self.params()
        # Pixelate is now a source-stage transform, not a downstream renderer mode.
        p = replace(p, pixelate_enabled=False)
        
        if self.img_full_rgba is None and not self._layers:
            tr = self._get_transform()
            empty = Image.new("RGBA", self._artboard_size_px_from_transform(tr), self._bg_rgba())
            self._prev_pix = pil_to_qpixmap(empty)
            if self.prev_lbl:
                self.prev_lbl.setPixmap(self._prev_pix)
                self.prev_lbl.update()
            return

        # Per-layer effects: render each layer independently and composite
        # During interaction, fall through to the standard optimized pipeline for speed
        if self._has_per_layer_effects():
            self._update_preview_per_layer(force)
            return

        tr = self._get_transform()
        
        # Smart preview caching - check if we can reuse a cached preview
        preview_key = (
            self._get_params_hash(p), 
            tr.scale_pct, self._offset_x, self._offset_y,
            self.interacting, force
        )
        
        # Skip re-render if nothing changed (works during interaction too)
        if not force and preview_key in self._preview_cache:
            cached_pixmap = self._preview_cache[preview_key]
            if self.prev_lbl:
                self.prev_lbl.setPixmap(cached_pixmap)
                self.prev_lbl.update()
            return
        
        preview_scale = 1.0

        if preview_scale != 1.0:
            art_rgba_small = self._compose_on_artboard_scaled_preview(tr, preview_scale)
            p_eff = replace(p, cell=p.cell*preview_scale, stroke=max(1.0, p.stroke*preview_scale),
                          halftone_slice_shift_amt=max(1, int(p.halftone_slice_shift_amt*preview_scale)),
                          halftone_vertical_slice_shift_amt=max(1, int(p.halftone_vertical_slice_shift_amt*preview_scale)))
            size_full = self._artboard_size_px_from_transform(tr)
            if p.stereogram_mode and hasattr(self, 'stereo_core'):
                # Use transparent-bg artboard so stereogram preserves alpha
                art_trans_small = self._compose_on_artboard(self._get_processed_source_image(None) or self.img_full_rgba, tr, transparent_bg=True)  # type: ignore[arg-type]
                if art_trans_small is not None and preview_scale != 1.0:
                    sz = (max(1, int(art_trans_small.width * preview_scale)), max(1, int(art_trans_small.height * preview_scale)))
                    art_trans_small = art_trans_small.resize(sz, Image.Resampling.NEAREST).resize(art_trans_small.size, Image.Resampling.NEAREST)
                stereo_result = self.stereo_core.render_stereogram(art_trans_small if art_trans_small is not None else art_rgba_small, p)
                base_img = stereo_result
            elif p.grayscale_mode:
                arrK = np.asarray(art_rgba_small.convert("L"), dtype=np.float32)/255.0
                cov = (1.0 - arrK) if not p.invert_gray else arrK
                cov = np.clip(cov, 0, 1) ** self._gamma_from_contrast(100)
                
                # Apply slice shift effects (glitch FX)
                cov = self._apply_slice_shift(cov, p)
                cov = self._apply_vertical_slice_shift(cov, p)
                cov = self._apply_smear_drag(cov, p, 0)
                cov = self._apply_macroblock_corruption(cov, p, 0)
                
                cov = self._apply_halftone_slice_shift(cov, p_eff)
                cov = self._apply_halftone_vertical_slice_shift(cov, p_eff)
                cov = self._maybe_dither_arr(cov, p_eff)
                
                if p.pixelate_enabled:
                    z = np.zeros_like(cov)
                    base_img = self._render_pixelate({'c': z, 'm': z, 'y': z, 'k': cov}, p)
                elif p.diffusion_enabled and p.diffusion_intensity > 0:
                    # Diffusion mode — coverage IS the output, skip halftone dots
                    h_px, w_px = cov.shape
                    k_uint8 = (np.clip(cov, 0, 1) * 255).astype(np.uint8)
                    mask = Image.fromarray(k_uint8)
                    base_img = Image.new("RGBA", (w_px, h_px), (255, 255, 255, 255))
                    base_img.paste((0,0,0,255), (0,0,w_px,h_px), mask)
                else:
                    plate = self._render_plate_from_arr(cov, p_eff, p.ang_k)
                    displaced_dict = self._apply_displacement({'k': plate}, p_eff)
                    final_plate = displaced_dict['k']
                    base_img = Image.new("RGBA", final_plate.size, (255, 255, 255, 255))
                    base_img.paste((0,0,0,255), (0,0,final_plate.width,final_plate.height), final_plate.getchannel("A"))
            else:
                _icc_cache_key = (id(self.img_full_rgba), art_rgba_small.size, self.cmyk_icc_path)
                if self.interacting and self._interact_cmyk_cache_key == _icc_cache_key and self._interact_cmyk_cache_img is not None:
                    base_cmyk_small = self._interact_cmyk_cache_img
                else:
                    base_cmyk_small = rgba_to_cmyk_with_icc(art_rgba_small, self.cmyk_icc_path)
                    if self.interacting:
                        self._interact_cmyk_cache_key = _icc_cache_key
                        self._interact_cmyk_cache_img = base_cmyk_small
                c, m, y, k = base_cmyk_small.split()
                def cov_of(ch_img):
                    a = np.asarray(ch_img, dtype=np.float32)/255.0
                    return np.clip(a, 0, 1) ** self._gamma_from_contrast(100)
                arrs = {'c': cov_of(c), 'm': cov_of(m), 'y': cov_of(y), 'k': cov_of(k)}
                
                channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                for ch in list(arrs.keys()):
                    # Apply slice shift effects (glitch FX)
                    arrs[ch] = self._apply_slice_shift(arrs[ch], p)
                    arrs[ch] = self._apply_vertical_slice_shift(arrs[ch], p)
                    arrs[ch] = self._apply_smear_drag(arrs[ch], p, channel_idx_map.get(ch, 0))
                    arrs[ch] = self._apply_macroblock_corruption(arrs[ch], p, channel_idx_map.get(ch, 0))
                    
                    arrs[ch] = self._apply_halftone_slice_shift(arrs[ch], p_eff)
                    arrs[ch] = self._apply_halftone_vertical_slice_shift(arrs[ch], p_eff)
                    arrs[ch] = self._maybe_dither_arr(arrs[ch], p_eff, channel_idx_map.get(ch, 0))
                
                # Apply cross-channel bleed after all channels are dithered
                if p.cross_channel_bleed > 0:
                    arrs = self._apply_cross_channel_bleed(arrs, p)
                if p.channel_desync > 0:
                    arrs = self._apply_channel_desync(arrs, p)
                
                if p.pixelate_enabled:
                    base_img = self._render_pixelate(arrs, p)
                elif p.diffusion_enabled and p.diffusion_intensity > 0:
                    # Diffusion mode — coverage IS the output, skip halftone dots
                    base_img = self._composite_from_cov(arrs['c'], arrs['m'], arrs['y'], arrs['k'])
                else:
                    ex = self._pool
                    channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                    futs = {ch: ex.submit(self._render_plate_from_arr, arr, p_eff, getattr(p, f"ang_{ch}"), None, channel_idx_map[ch]) for ch, arr in arrs.items()}
                    plates_small = {ch: f.result() for ch, f in futs.items()}
                    displaced = self._apply_displacement(plates_small, p_eff)
                    cov = [np.asarray(displaced[ch].getchannel("A"), dtype=np.float32)/255.0 for ch in "cmyk"]
                    base_img = self._composite_from_cov(cov[0], cov[1], cov[2], cov[3])
            # During interaction, skip the PIL upscale — PreviewArea compensates via pixmap_scale.
            # At release (force=True / not interacting) we restore to full size.
            if not self.interacting:
                base_img = base_img.resize(size_full, Image.Resampling.NEAREST)
        else:
            art_rgba = self._artboard_rgba_cached(tr); art_key = self._art_key(tr)
            art_trans = self._artboard_rgba_transparent(tr)
            if p.stereogram_mode and hasattr(self, 'stereo_core'):
                stereo_result = self.stereo_core.render_stereogram(art_trans, p)
                base_img = stereo_result
            elif p.grayscale_mode:
                arrK_full = self._arr_gray_cached(tr, invert=p.invert_gray)
                
                # Apply slice shift effects (glitch FX)
                arrK_full = self._apply_slice_shift(arrK_full, p)
                arrK_full = self._apply_vertical_slice_shift(arrK_full, p)
                arrK_full = self._apply_smear_drag(arrK_full, p, 0)
                arrK_full = self._apply_macroblock_corruption(arrK_full, p, 0)
                
                arrK_full = self._apply_halftone_slice_shift(arrK_full, p)
                arrK_full = self._apply_halftone_vertical_slice_shift(arrK_full, p)
                arrK_full = self._maybe_dither_arr(arrK_full, p)
                
                if p.pixelate_enabled:
                    z = np.zeros_like(arrK_full)
                    base_img = self._render_pixelate({'c': z, 'm': z, 'y': z, 'k': arrK_full}, p)
                elif p.diffusion_enabled and p.diffusion_intensity > 0:
                    # Diffusion mode — coverage IS the output, skip halftone dots
                    h_px, w_px = arrK_full.shape
                    k_uint8 = (np.clip(arrK_full, 0, 1) * 255).astype(np.uint8)
                    mask = Image.fromarray(k_uint8)
                    base_img = Image.new("RGBA", (w_px, h_px), (255, 255, 255, 255))
                    base_img.paste((0,0,0,255), (0,0,w_px,h_px), mask)
                else:
                    plate = self._render_plate_from_arr(arrK_full, p, p.ang_k)
                    displaced_dict = self._apply_displacement({'k': plate}, p)
                    final_plate = displaced_dict['k']
                    base_img = Image.new("RGBA", final_plate.size, (255, 255, 255, 255))
                    base_img.paste((0,0,0,255), (0,0,final_plate.width,final_plate.height), final_plate.getchannel("A"))
            else:
                channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                if p.preview_channel == "composite" and self.full_comp.isChecked():
                    _ch_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                    def _mk(ch):
                        arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
                        # Apply slice shift effects (glitch FX)
                        arr = self._apply_slice_shift(arr, p)
                        arr = self._apply_vertical_slice_shift(arr, p)
                        arr = self._apply_smear_drag(arr, p, _ch_idx_map.get(ch, 0))
                        arr = self._apply_macroblock_corruption(arr, p, _ch_idx_map.get(ch, 0))
                        arr = self._apply_halftone_slice_shift(arr, p)
                        arr = self._apply_halftone_vertical_slice_shift(arr, p)
                        return self._maybe_dither_arr(arr, p, _ch_idx_map.get(ch, 0))
                    arrs = {'c': _mk('c'), 'm': _mk('m'), 'y': _mk('y'), 'k': _mk('k')}
                    
                    if p.pixelate_enabled:
                        base_img = self._render_pixelate(arrs, p)
                    elif p.diffusion_enabled and p.diffusion_intensity > 0:
                        # Diffusion mode — coverage IS the output, skip halftone dots
                        base_img = self._composite_from_cov(arrs['c'], arrs['m'], arrs['y'], arrs['k'])
                    else:
                        # Apply cross-channel bleed after dithering
                        if p.cross_channel_bleed > 0:
                            arrs = self._apply_cross_channel_bleed(arrs, p)
                        if p.channel_desync > 0:
                            arrs = self._apply_channel_desync(arrs, p)
                        
                        ex = self._pool
                        channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                        futs = {ch: ex.submit(self._render_plate_from_arr, arr, p, getattr(p, f"ang_{ch}"), None, channel_idx_map[ch]) for ch, arr in arrs.items()}
                        plates = {ch: f.result() for ch, f in futs.items()}
                        displaced = self._apply_displacement(plates, p)
                        cov = [np.asarray(displaced[ch].getchannel("A"), dtype=np.float32)/255.0 for ch in "cmyk"]
                        base_img = self._composite_from_cov(cov[0], cov[1], cov[2], cov[3])
                else:
                    ch = p.preview_channel if p.preview_channel != "composite" else "k"
                    arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
                    
                    # Apply slice shift effects (glitch FX)
                    arr = self._apply_slice_shift(arr, p)
                    arr = self._apply_vertical_slice_shift(arr, p)
                    arr = self._apply_smear_drag(arr, p, channel_idx_map.get(ch, 3))
                    arr = self._apply_macroblock_corruption(arr, p, channel_idx_map.get(ch, 3))
                    
                    arr = self._apply_halftone_slice_shift(arr, p)
                    arr = self._apply_halftone_vertical_slice_shift(arr, p)
                    arr = self._maybe_dither_arr(arr, p)
                    
                    if p.pixelate_enabled:
                        # For single-channel pixelate preview, build full CMYK arrs
                        _pix_arrs = {}
                        for _ch in 'cmyk':
                            _pix_arrs[_ch] = self._arr_cmyk_cached(art_key, art_trans, _ch, p.invert_gray)
                            _pix_arrs[_ch] = self._apply_slice_shift(_pix_arrs[_ch], p)
                            _pix_arrs[_ch] = self._apply_vertical_slice_shift(_pix_arrs[_ch], p)
                            _pix_arrs[_ch] = self._apply_smear_drag(_pix_arrs[_ch], p, channel_idx_map.get(_ch, 0))
                            _pix_arrs[_ch] = self._apply_macroblock_corruption(_pix_arrs[_ch], p, channel_idx_map.get(_ch, 0))
                            _pix_arrs[_ch] = self._apply_halftone_slice_shift(_pix_arrs[_ch], p)
                            _pix_arrs[_ch] = self._apply_halftone_vertical_slice_shift(_pix_arrs[_ch], p)
                            _pix_arrs[_ch] = self._maybe_dither_arr(_pix_arrs[_ch], p)
                        plate = self._render_pixelate_channel(_pix_arrs, ch, p)
                        base_img = Image.new("RGBA", plate.size, (255, 255, 255, 255))
                        channel_color = (0, 0, 0, 255) if p.invert_gray else {
                            'c': (0, 255, 255, 255),
                            'm': (255, 0, 255, 255),
                            'y': (255, 255, 0, 255),
                            'k': (0, 0, 0, 255)
                        }.get(ch, (0, 0, 0, 255))
                        base_img.paste(channel_color, (0,0,plate.width,plate.height), plate.getchannel("A"))
                    elif p.diffusion_enabled and p.diffusion_intensity > 0:
                        # Diffusion mode — coverage IS the output, skip halftone dots
                        h_px, w_px = arr.shape
                        ch_uint8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
                        mask = Image.fromarray(ch_uint8)
                        base_img = Image.new("RGBA", (w_px, h_px), (255, 255, 255, 255))
                        channel_color = (0, 0, 0, 255) if p.invert_gray else {
                            'c': (0, 255, 255, 255),
                            'm': (255, 0, 255, 255),
                            'y': (255, 255, 0, 255),
                            'k': (0, 0, 0, 255)
                        }.get(ch, (0, 0, 0, 255))
                        base_img.paste(channel_color, (0,0,w_px,h_px), mask)
                    else:
                        ang = getattr(p, f"ang_{ch}")
                        channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                        plate = self._render_plate_from_arr(arr, p, ang, None, channel_idx_map.get(ch, 3))
                        displaced_dict = self._apply_displacement({ch: plate}, p)
                        final_plate = displaced_dict[ch]
                        base_img = Image.new("RGBA", final_plate.size, (255, 255, 255, 255))
                        channel_color = (0, 0, 0, 255) if p.invert_gray else {
                            'c': (0, 255, 255, 255),
                            'm': (255, 0, 255, 255),
                            'y': (255, 255, 0, 255),
                            'k': (0, 0, 0, 255)
                        }.get(ch, (0, 0, 0, 255))
                        base_img.paste(channel_color, (0,0,final_plate.width,final_plate.height), final_plate.getchannel("A"))
        
        if 'base_img' in locals():  # Make sure base_img is defined
            # Screen printing compatible glitch effects only
            # (Removed chromatic aberration, pixel sorting, and data corruption)
            
            # Only snapshot for reg-mark fast path when not dragging sliders
            bg_p = self._get_bg_registration_params()
            if not self.interacting and bg_p.regs_on:
                self._last_render_base_rgba = base_img.copy()

            # Apply content alpha so empty artboard areas stay transparent
            if self.img_full_rgba is not None and not (p.stereogram_mode and hasattr(self, 'stereo_core')):
                # Cache the full-res content alpha per art_key; resize on demand.
                # This avoids recompositing the artboard every interaction frame.
                art_key = self._art_key(tr)
                if self._content_alpha_cache_key != art_key or self._content_alpha_cache_img is None:
                    src = self._get_processed_source_image(None) or self.img_full_rgba
                    content_art = self._compose_on_artboard(src, tr, transparent_bg=True)
                    self._content_alpha_cache_key = art_key
                    self._content_alpha_cache_img = content_art.getchannel("A")
                content_alpha = self._content_alpha_cache_img
                if content_alpha.size != base_img.size:
                    content_alpha = content_alpha.resize(base_img.size, Image.Resampling.NEAREST)
                base_img.putalpha(content_alpha)
            # Composite onto bg-colored artboard so transparent areas show bg color
            bg_canvas = Image.new("RGBA", base_img.size, self._bg_rgba())
            bg_canvas.alpha_composite(base_img)
            base_img = bg_canvas

        bg_p = self._get_bg_registration_params()
        # Skip reg marks during interaction: image may be at reduced resolution
        # and absolute reg_offset_px values would be misaligned
        if bg_p.regs_on and not self.interacting:
            base_img = self._paste_regmarks_bitmap(base_img, bg_p)

        self._prev_pix = pil_to_qpixmap(base_img)
        
        # Cache the result for faster subsequent renders (but not during interaction)
        if not self.interacting and not force and len(self._preview_cache) < 20:
            self._preview_cache[preview_key] = self._prev_pix
        
        if self.prev_lbl:
            # Pass pixmap_scale so PreviewArea compensates zoom without PIL upscale
            self.prev_lbl.setPixmap(self._prev_pix, preview_scale)
            self.prev_lbl.update()
        self._halftone_dirty = False
        self._update_scrollbar_ranges()

    def _render_full_res(self, p: Params, tr: Transform, single_channel: Optional[str] = None, skip_content_alpha: bool = False) -> Image.Image:
        """Render full resolution image for export.
        
        Args:
            p: Parameters
            tr: Transform
            single_channel: If specified ('c', 'm', 'y', 'k'), render only that channel with spot color.
                           If None, render full CMYK composite.
            skip_content_alpha: If True, skip content-alpha masking and bg compositing
                               (caller handles alpha, e.g. per-layer pipeline).
        """
        # Pixelate is now applied at source-stage via _get_processed_source_image().
        p = replace(p, pixelate_enabled=False)
        art_rgba = self._artboard_rgba_cached(tr)
        art_trans = self._artboard_rgba_transparent(tr)
        art_key = self._art_key(tr)

        if p.stereogram_mode and hasattr(self, 'stereo_core'):
            art_trans = self._artboard_rgba_transparent(tr)
            base_img = self.stereo_core.render_stereogram(art_trans, p)
            return self._paste_regmarks_bitmap(base_img, p) if p.regs_on else base_img

        if p.grayscale_mode:
            arrK_full = self._arr_gray_cached(tr, invert=p.invert_gray)
            arrK_full = self._apply_slice_shift(arrK_full, p)
            arrK_full = self._apply_vertical_slice_shift(arrK_full, p)
            arrK_full = self._apply_smear_drag(arrK_full, p, 0)
            arrK_full = self._apply_macroblock_corruption(arrK_full, p, 0)
            arrK_full = self._apply_halftone_slice_shift(arrK_full, p)
            arrK_full = self._apply_halftone_vertical_slice_shift(arrK_full, p)
            arrK_full = self._maybe_dither_arr(arrK_full, p)
            if p.pixelate_enabled:
                z = np.zeros_like(arrK_full)
                base_img = self._render_pixelate({'c': z, 'm': z, 'y': z, 'k': arrK_full}, p)
            elif p.diffusion_enabled and p.diffusion_intensity > 0:
                h_px, w_px = arrK_full.shape
                k_uint8 = (np.clip(arrK_full, 0, 1) * 255).astype(np.uint8)
                mask = Image.fromarray(k_uint8)
                base_img = Image.new("RGBA", (w_px, h_px), (255, 255, 255, 255))
                base_img.paste((0,0,0,255), (0,0,w_px,h_px), mask)
            else:
                plate = self._render_plate_from_arr(arrK_full, p, p.ang_k, exact_cell=True)
                final_plate = self._apply_displacement({'k': plate}, p)['k']
                base_img = Image.new("RGBA", final_plate.size, (255, 255, 255, 255))
                base_img.paste((0,0,0,255), (0,0,final_plate.width,final_plate.height), final_plate.getchannel("A"))
            # Apply content alpha + bg color for export (skip in per-layer pipeline)
            if not skip_content_alpha:
                src = self._get_processed_source_image(None) or self.img_full_rgba
                if src is not None:
                    content_art = self._compose_on_artboard(src, tr, transparent_bg=True)
                    content_alpha = content_art.getchannel("A")
                    if content_alpha.size != base_img.size:
                        content_alpha = content_alpha.resize(base_img.size, Image.Resampling.NEAREST)
                    base_img.putalpha(content_alpha)
                    bg_canvas = Image.new("RGBA", base_img.size, self._bg_rgba())
                    bg_canvas.alpha_composite(base_img)
                    base_img = bg_canvas
            return self._paste_regmarks_bitmap(base_img, p) if p.regs_on else base_img

        # Single channel export mode (when full_composite is unchecked)
        if single_channel and single_channel in "cmyk":
            ch = single_channel
            channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
            arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
            arr = self._apply_slice_shift(arr, p)
            arr = self._apply_vertical_slice_shift(arr, p)
            arr = self._apply_smear_drag(arr, p, channel_idx_map.get(ch, 0))
            arr = self._apply_macroblock_corruption(arr, p, channel_idx_map.get(ch, 0))
            arr = self._apply_halftone_slice_shift(arr, p)
            arr = self._apply_halftone_vertical_slice_shift(arr, p)
            arr = self._maybe_dither_arr(arr, p)
            
            if p.pixelate_enabled:
                _pix_arrs = {}
                for _ch in 'cmyk':
                    _pix_arrs[_ch] = self._arr_cmyk_cached(art_key, art_trans, _ch, p.invert_gray)
                    _pix_arrs[_ch] = self._apply_slice_shift(_pix_arrs[_ch], p)
                    _pix_arrs[_ch] = self._apply_vertical_slice_shift(_pix_arrs[_ch], p)
                    _pix_arrs[_ch] = self._apply_smear_drag(_pix_arrs[_ch], p, channel_idx_map.get(_ch, 0))
                    _pix_arrs[_ch] = self._apply_macroblock_corruption(_pix_arrs[_ch], p, channel_idx_map.get(_ch, 0))
                    _pix_arrs[_ch] = self._apply_halftone_slice_shift(_pix_arrs[_ch], p)
                    _pix_arrs[_ch] = self._apply_halftone_vertical_slice_shift(_pix_arrs[_ch], p)
                    _pix_arrs[_ch] = self._maybe_dither_arr(_pix_arrs[_ch], p)
                plate = self._render_pixelate_channel(_pix_arrs, ch, p)
                base_img = Image.new("RGBA", plate.size, (255, 255, 255, 255))
                channel_color = (0, 0, 0, 255) if p.invert_gray else {
                    'c': (0, 255, 255, 255),
                    'm': (255, 0, 255, 255),
                    'y': (255, 255, 0, 255),
                    'k': (0, 0, 0, 255)
                }.get(ch, (0, 0, 0, 255))
                base_img.paste(channel_color, (0,0,plate.width,plate.height), plate.getchannel("A"))
            elif p.diffusion_enabled and p.diffusion_intensity > 0:
                # Diffusion mode — coverage IS the output, skip halftone dots
                h_px, w_px = arr.shape
                ch_uint8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
                mask = Image.fromarray(ch_uint8)
                base_img = Image.new("RGBA", (w_px, h_px), (255, 255, 255, 255))
                channel_color = (0, 0, 0, 255) if p.invert_gray else {
                    'c': (0, 255, 255, 255),
                    'm': (255, 0, 255, 255),
                    'y': (255, 255, 0, 255),
                    'k': (0, 0, 0, 255)
                }.get(ch, (0, 0, 0, 255))
                base_img.paste(channel_color, (0,0,w_px,h_px), mask)
            else:
                ang = getattr(p, f"ang_{ch}")
                plate = self._render_plate_from_arr(arr, p, ang, None, channel_idx_map[ch], exact_cell=True)
                displaced_dict = self._apply_displacement({ch: plate}, p)
                final_plate = displaced_dict[ch]
                base_img = Image.new("RGBA", final_plate.size, (255, 255, 255, 255))
                channel_color = (0, 0, 0, 255) if p.invert_gray else {
                    'c': (0, 255, 255, 255),
                    'm': (255, 0, 255, 255),
                    'y': (255, 255, 0, 255),
                    'k': (0, 0, 0, 255)
                }.get(ch, (0, 0, 0, 255))
                base_img.paste(channel_color, (0,0,final_plate.width,final_plate.height), final_plate.getchannel("A"))
            # Apply content alpha + bg color for export (skip in per-layer pipeline)
            if not skip_content_alpha:
                src = self._get_processed_source_image(None) or self.img_full_rgba
                if src is not None:
                    content_art = self._compose_on_artboard(src, tr, transparent_bg=True)
                    content_alpha = content_art.getchannel("A")
                    if content_alpha.size != base_img.size:
                        content_alpha = content_alpha.resize(base_img.size, Image.Resampling.NEAREST)
                    base_img.putalpha(content_alpha)
                    bg_canvas = Image.new("RGBA", base_img.size, self._bg_rgba())
                    bg_canvas.alpha_composite(base_img)
                    base_img = bg_canvas
            return self._paste_regmarks_bitmap(base_img, p) if p.regs_on else base_img

        # Full CMYK composite mode
        _ch_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
        def _mk(ch): 
            arr = self._apply_slice_shift(self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray), p)
            arr = self._apply_vertical_slice_shift(arr, p)
            arr = self._apply_smear_drag(arr, p, _ch_idx_map.get(ch, 0))
            arr = self._apply_macroblock_corruption(arr, p, _ch_idx_map.get(ch, 0))
            arr = self._apply_halftone_slice_shift(arr, p)
            arr = self._apply_halftone_vertical_slice_shift(arr, p)
            return self._maybe_dither_arr(arr, p, _ch_idx_map.get(ch, 0))
        arrs = {'c': _mk('c'), 'm': _mk('m'), 'y': _mk('y'), 'k': _mk('k')}
        
        if p.pixelate_enabled:
            base_img = self._render_pixelate(arrs, p)
        elif p.diffusion_enabled and p.diffusion_intensity > 0:
            # Diffusion mode — coverage IS the output, skip halftone dots
            base_img = self._composite_from_cov(arrs['c'], arrs['m'], arrs['y'], arrs['k'])
        else:
            # Apply cross-channel bleed after dithering
            if p.cross_channel_bleed > 0:
                arrs = self._apply_cross_channel_bleed(arrs, p)
            if p.channel_desync > 0:
                arrs = self._apply_channel_desync(arrs, p)
            
            ex = self._pool
            futs = {
                ch: ex.submit(self._render_plate_from_arr, arr, p, getattr(p, f"ang_{ch}"), None, _ch_idx_map[ch])
                for ch, arr in arrs.items()
            }
            plates = {ch: f.result() for ch, f in futs.items()}
            displaced = self._apply_displacement(plates, p)
            cov = [np.asarray(displaced[ch].getchannel("A"), dtype=np.float32)/255.0 for ch in "cmyk"]
            base_img = self._composite_from_cov(cov[0], cov[1], cov[2], cov[3])
            
        return self._paste_regmarks_bitmap(base_img, p) if p.regs_on else base_img

    def on_export_png(self):
        if self.img_full_rgba is None and not self._layers:
            QMessageBox.warning(self, "No image", "Open an image first."); return
        if not any(l.visible for l in self._layers):
            QMessageBox.warning(self, "No visible layers", "Turn on at least one layer to export."); return
        save_path, _ = QFileDialog.getSaveFileName(self, "save PNG", self._default_save_path(self._default_filename_stem() + ".png"), "PNG (*.png)")
        if not save_path: return
        if not save_path.lower().endswith(".png"):
            save_path += ".png"
        try:
            self._sync_active_layer_params_from_ui()
            p = self.params(); tr = self._get_transform()
            # Per-layer rendering if layers have individual effects
            if self._has_per_layer_effects():
                img_rgba = self._render_full_res_per_layer(tr)
            else:
                # Determine if exporting single channel or full composite
                single_ch = None
                if not p.grayscale_mode and not self.full_comp.isChecked():
                    ch = p.preview_channel if p.preview_channel != "composite" else "k"
                    single_ch = ch
                img_rgba = self._render_full_res(p, tr, single_channel=single_ch)
            img_rgba = self._upscale_for_export(img_rgba)
            img_rgb = img_rgba.convert("RGB")
            img_rgb.save(save_path, "PNG", optimize=True)
            QMessageBox.information(self, "Saved", f"PNG export complete:\n{save_path}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def on_export_tiff_cmyk(self):
        if self.img_full_rgba is None and not self._layers:
            QMessageBox.warning(self, "No image", "Open an image first."); return
        if not any(l.visible for l in self._layers):
            QMessageBox.warning(self, "No visible layers", "Turn on at least one layer to export."); return
        base_path, _ = QFileDialog.getSaveFileName(self, "save TIFF plates", self._default_save_path(self._default_filename_stem() + ".tif"), "TIFF (*.tif *.tiff)")
        if not base_path: return
        if base_path.lower().endswith((".tif", ".tiff")):
            base_path = base_path[:-4]

        try:
            self._sync_active_layer_params_from_ui()
            p = self.params(); tr = self._get_transform()

            # If per-layer effects are active, render clean binary plates per-channel
            if self._has_per_layer_effects():
                folder = f"{base_path}_TIFF_Plates"
                os.makedirs(folder, exist_ok=True)

                plates = self._render_plates_per_layer(tr)
                bg_p = self._get_bg_registration_params()

                # Apply registration marks to L-mode plates
                def _apply_regs_to_plate(plate_l):
                    if bg_p.regs_on:
                        mask = ImageChops.invert(plate_l)
                        img_rgba = Image.new("RGBA", plate_l.size, (255,255,255,255))
                        img_rgba.paste((0,0,0,255), (0,0,plate_l.width,plate_l.height), mask)
                        img_rgba = self._paste_regmarks_bitmap(img_rgba, bg_p)
                        return img_rgba.convert("L")
                    return plate_l

                # B/W halftone: export only K plate
                if p.grayscale_mode:
                    img = _apply_regs_to_plate(plates['k'])
                    img = self._upscale_for_export(img)
                    out_path = os.path.join(folder, "K.tif")
                    img.save(out_path, "TIFF", dpi=(DOC_DPI, DOC_DPI), compression="tiff_lzw")
                    QMessageBox.information(self, "Saved", f"B/W TIFF plate saved:\n{out_path}")
                else:
                    for ch in "CMYK":
                        img = _apply_regs_to_plate(plates[ch.lower()])
                        img = self._upscale_for_export(img)
                        out_path = os.path.join(folder, f"{ch}.tif")
                        img.save(out_path, "TIFF", dpi=(DOC_DPI, DOC_DPI), compression="tiff_lzw")
                    QMessageBox.information(self, "Saved", f"TIFF separations saved in folder:\n{folder}")
                return

            art_rgba = self._artboard_rgba_cached(tr)
            art_trans = self._artboard_rgba_transparent(tr)
            art_key = self._art_key(tr)
    
            folder = f"{base_path}_TIFF_Plates"
            os.makedirs(folder, exist_ok=True)
    
            # Check if grayscale mode is enabled
            if p.grayscale_mode:
                # Export only K (black) channel for grayscale mode
                arr = self._arr_gray_cached(tr, p.invert_gray)
                arr = self._apply_slice_shift(arr, p)
                arr = self._apply_vertical_slice_shift(arr, p)
                arr = self._apply_smear_drag(arr, p, 0)
                arr = self._apply_macroblock_corruption(arr, p, 0)
                arr = self._apply_halftone_slice_shift(arr, p)
                arr = self._apply_halftone_vertical_slice_shift(arr, p)
                plate = self._render_plate_from_arr(arr, p, p.ang_k, exact_cell=True)
                plate = self._apply_displacement({'k': plate}, p)['k']
    
                mask = plate.getchannel("A")
                img = Image.new("L", plate.size, 255)
                img.paste(0, mask=mask)
    
                if p.regs_on:
                    img_rgba = Image.new("RGBA", img.size, (255,255,255,255))
                    img_rgba.paste((0,0,0,255), (0,0,img.width,img.height), mask)
                    img_rgba = self._paste_regmarks_bitmap(img_rgba, p)
                    img = img_rgba.convert("L")
    
                img = self._upscale_for_export(img)
                out_path = os.path.join(folder, "K.tif")
                img.save(out_path, "TIFF", dpi=(DOC_DPI, DOC_DPI), compression="tiff_lzw")
    
                QMessageBox.information(self, "Saved", f"B/W TIFF plate saved:\n{out_path}")
            else:
                # Check if single channel mode (full composite unchecked)
                if not self.full_comp.isChecked():
                    # Export only the selected preview channel
                    ch = p.preview_channel if p.preview_channel != "composite" else "k"
                    ch_upper = ch.upper()
                    ang = getattr(p, f"ang_{ch}")
                    channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                    
                    arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
                    arr = self._apply_slice_shift(arr, p)
                    arr = self._apply_vertical_slice_shift(arr, p)
                    arr = self._apply_smear_drag(arr, p, channel_idx_map[ch])
                    arr = self._apply_macroblock_corruption(arr, p, channel_idx_map[ch])
                    arr = self._apply_halftone_slice_shift(arr, p)
                    arr = self._apply_halftone_vertical_slice_shift(arr, p)
                    plate = self._render_plate_from_arr(arr, p, ang, None, channel_idx_map[ch], exact_cell=True)
                    plate = self._apply_displacement({ch: plate}, p)[ch]
                    
                    mask = plate.getchannel("A")
                    img = Image.new("L", plate.size, 255)
                    img.paste(0, mask=mask)
                    
                    if p.regs_on:
                        img_rgba = Image.new("RGBA", img.size, (255,255,255,255))
                        img_rgba.paste((0,0,0,255), (0,0,img.width,img.height), mask)
                        img_rgba = self._paste_regmarks_bitmap(img_rgba, p)
                        img = img_rgba.convert("L")
                    
                    img = self._upscale_for_export(img)
                    out_path = os.path.join(folder, f"{ch_upper}.tif")
                    img.save(out_path, "TIFF", dpi=(DOC_DPI, DOC_DPI), compression="tiff_lzw")
                    
                    QMessageBox.information(self, "Saved", f"Single channel ({ch_upper}) TIFF plate saved:\n{out_path}")
                else:
                    # Export all four CMYK channel plates
                    chans = [("C", p.ang_c, 0), ("M", p.ang_m, 1), ("Y", p.ang_y, 2), ("K", p.ang_k, 3)]
                    for ch, ang, ch_idx in chans:
                        arr = self._arr_cmyk_cached(art_key, art_trans, ch.lower(), p.invert_gray)
                        arr = self._apply_slice_shift(arr, p)
                        arr = self._apply_vertical_slice_shift(arr, p)
                        arr = self._apply_smear_drag(arr, p, ch_idx)
                        arr = self._apply_macroblock_corruption(arr, p, ch_idx)
                        arr = self._apply_halftone_slice_shift(arr, p)
                        arr = self._apply_halftone_vertical_slice_shift(arr, p)
                        plate = self._render_plate_from_arr(arr, p, ang, None, ch_idx, exact_cell=True)
                        plate = self._apply_displacement({ch.lower(): plate}, p)[ch.lower()]
            
                        mask = plate.getchannel("A")
                        img = Image.new("L", plate.size, 255)
                        img.paste(0, mask=mask)
            
                        if p.regs_on:
                            img_rgba = Image.new("RGBA", img.size, (255,255,255,255))
                            img_rgba.paste((0,0,0,255), (0,0,img.width,img.height), mask)
                            img_rgba = self._paste_regmarks_bitmap(img_rgba, p)
                            img = img_rgba.convert("L")
            
                        img = self._upscale_for_export(img)
                        out_path = os.path.join(folder, f"{ch}.tif")
                        img.save(out_path, "TIFF", dpi=(DOC_DPI, DOC_DPI), compression="tiff_lzw")
            
                    # composite CMYK file
                    if self._has_per_layer_effects():
                        composite = self._render_full_res_per_layer(tr)
                    else:
                        composite = self._render_full_res(p, tr)
                        if p.regs_on:
                            composite = self._paste_regmarks_bitmap(composite, p)
                    composite = self._upscale_for_export(composite)
                    comp_cmyk = rgba_to_cmyk_with_icc(composite)
                    comp_out = os.path.join(folder, "Composite.tif")
                    comp_cmyk.save(comp_out, "TIFF", dpi=(DOC_DPI, DOC_DPI), compression="tiff_lzw")
            
                    QMessageBox.information(self, "Saved", f"TIFF separations + composite saved in folder:\n{folder}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def on_export_svg(self):
        if self.img_full_rgba is None and not self._layers:
            QMessageBox.warning(self, "No image", "Open an image first."); return
        if not any(l.visible for l in self._layers):
            QMessageBox.warning(self, "No visible layers", "Turn on at least one layer to export."); return
        base_path, _ = QFileDialog.getSaveFileName(self, "save SVG plates", self._default_save_path(self._default_filename_stem() + ".svg"), "SVG (*.svg)")
        if not base_path: return
        if base_path.lower().endswith(".svg"):
            base_path = base_path[:-4]
    
        try:
            self._sync_active_layer_params_from_ui()
            p = self.params(); tr = self._get_transform()
            W, H = self._artboard_size_px_from_transform(tr)
            W_in, H_in = self._get_doc_size_in()  # Get artboard size in inches

            # If per-layer effects are active, the rendered result already has
            # halftone effects baked in — export as embedded raster PNG in SVG.
            # Diffusion mode is also raster-only and must be embedded, not vectorised.
            is_diffusion = p.diffusion_enabled and p.diffusion_intensity > 0
            if self._has_per_layer_effects() or is_diffusion:
                if self._has_per_layer_effects():
                    rendered_rgba = self._render_full_res_per_layer(tr)
                else:
                    rendered_rgba = self._render_full_res(p, tr)

                folder = f"{base_path}_SVG_Plates"
                os.makedirs(folder, exist_ok=True)

                import io, base64 as b64lib
                label = "Diffusion" if is_diffusion else "Composite"
                out_path = os.path.join(folder, f"{label}.svg")
                dwg = svgwrite.Drawing(
                    out_path,
                    size=(f"{W_in}in", f"{H_in}in"),
                    viewBox=f"0 0 {W} {H}"
                )
                buf = io.BytesIO()
                rendered_rgba.convert("RGB").save(buf, format='PNG')
                data_uri = "data:image/png;base64," + b64lib.b64encode(buf.getvalue()).decode('ascii')
                dwg.add(dwg.image(href=data_uri, insert=(0, 0), size=(W, H)))
                bg_p = self._get_bg_registration_params()
                if bg_p.regs_on:
                    self._add_regmarks_svg(dwg, bg_p, W, H)
                dwg.save()

                mode_label = "Diffusion raster" if is_diffusion else "SVG composite"
                QMessageBox.information(self, "Saved", f"{mode_label} saved ({W_in}×{H_in} in):\n{folder}")
                return

            art_rgba = self._artboard_rgba_cached(tr)
            art_trans = self._artboard_rgba_transparent(tr)
            art_key = self._art_key(tr)
    
            folder = f"{base_path}_SVG_Plates"
            os.makedirs(folder, exist_ok=True)
            
            # Helper to create SVG with correct physical size
            def create_svg_drawing(path):
                """Create SVG drawing with correct artboard size in inches and viewBox in pixels."""
                dwg = svgwrite.Drawing(
                    path,
                    size=(f"{W_in}in", f"{H_in}in"),  # Physical size in inches
                    viewBox=f"0 0 {W} {H}"  # Coordinate system in pixels
                )
                return dwg
    
            # Pre-compute CMYK arrays for pixelate SVG export
            self._svg_pixelate_cmyk_arrs = None
            if p.pixelate_enabled:
                if p.grayscale_mode:
                    _k = self._arr_gray_cached(tr, p.invert_gray)
                    _k = self._apply_slice_shift(_k, p)
                    _k = self._apply_vertical_slice_shift(_k, p)
                    _k = self._apply_smear_drag(_k, p, 0)
                    _k = self._apply_macroblock_corruption(_k, p, 0)
                    _k = self._apply_halftone_slice_shift(_k, p)
                    _k = self._apply_halftone_vertical_slice_shift(_k, p)
                    z = np.zeros_like(_k)
                    self._svg_pixelate_cmyk_arrs = {'c': z, 'm': z, 'y': z, 'k': _k}
                else:
                    _pix = {}
                    for _ch in 'cmyk':
                        _a = self._arr_cmyk_cached(art_key, art_trans, _ch, p.invert_gray)
                        _a = self._apply_slice_shift(_a, p)
                        _a = self._apply_vertical_slice_shift(_a, p)
                        _a = self._apply_smear_drag(_a, p, {'c': 0, 'm': 1, 'y': 2, 'k': 3}.get(_ch, 0))
                        _a = self._apply_macroblock_corruption(_a, p, {'c': 0, 'm': 1, 'y': 2, 'k': 3}.get(_ch, 0))
                        _a = self._apply_halftone_slice_shift(_a, p)
                        _a = self._apply_halftone_vertical_slice_shift(_a, p)
                        _pix[_ch] = _a
                    self._svg_pixelate_cmyk_arrs = _pix

            # Check if grayscale mode is enabled
            if p.grayscale_mode:
                # Export only K (black) channel for grayscale mode
                arr = self._arr_gray_cached(tr, p.invert_gray)
                arr = self._apply_slice_shift(arr, p)
                arr = self._apply_vertical_slice_shift(arr, p)
                arr = self._apply_smear_drag(arr, p, 0)
                arr = self._apply_macroblock_corruption(arr, p, 0)
                arr = self._apply_halftone_slice_shift(arr, p)
                arr = self._apply_halftone_vertical_slice_shift(arr, p)
                
                out_path = os.path.join(folder, "K.svg")
                dwg = create_svg_drawing(out_path)
                self._export_svg_channel_into(dwg, arr, p, p.ang_k, "#000000", 3)  # K channel
                if p.regs_on:
                    self._add_regmarks_svg(dwg, p, W, H)
                dwg.save()
                
                QMessageBox.information(self, "Saved", f"B/W SVG plate saved ({W_in}×{H_in} in):\n{out_path}")
            else:
                # Check if single channel mode (full composite unchecked)
                if not self.full_comp.isChecked():
                    # Export only the selected preview channel
                    ch = p.preview_channel if p.preview_channel != "composite" else "k"
                    ch_upper = ch.upper()
                    ang = getattr(p, f"ang_{ch}")
                    channel_idx_map = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                    
                    arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
                    arr = self._apply_slice_shift(arr, p)
                    arr = self._apply_vertical_slice_shift(arr, p)
                    arr = self._apply_smear_drag(arr, p, channel_idx_map[ch])
                    arr = self._apply_macroblock_corruption(arr, p, channel_idx_map[ch])
                    arr = self._apply_halftone_slice_shift(arr, p)
                    arr = self._apply_halftone_vertical_slice_shift(arr, p)
                    
                    out_path = os.path.join(folder, f"{ch_upper}.svg")
                    dwg = create_svg_drawing(out_path)
                    self._export_svg_channel_into(dwg, arr, p, ang, "#000000", channel_idx_map[ch])
                    if p.regs_on:
                        self._add_regmarks_svg(dwg, p, W, H)
                    dwg.save()
                    
                    QMessageBox.information(self, "Saved", f"Single channel ({ch_upper}) SVG plate saved ({W_in}×{H_in} in):\n{out_path}")
                else:
                    # Export all CMYK channels for color mode
                    chans = [("C", p.ang_c, 0), ("M", p.ang_m, 1), ("Y", p.ang_y, 2), ("K", p.ang_k, 3)]
                    for ch, ang, ch_idx in chans:
                        arr = self._arr_cmyk_cached(art_key, art_trans, ch.lower(), p.invert_gray)
                        arr = self._apply_slice_shift(arr, p)
                        arr = self._apply_vertical_slice_shift(arr, p)
                        arr = self._apply_smear_drag(arr, p, ch_idx)
                        arr = self._apply_macroblock_corruption(arr, p, ch_idx)
                        arr = self._apply_halftone_slice_shift(arr, p)
                        arr = self._apply_halftone_vertical_slice_shift(arr, p)
            
                        out_path = os.path.join(folder, f"{ch}.svg")
                        dwg = create_svg_drawing(out_path)
                        self._export_svg_channel_into(dwg, arr, p, ang, "#000000", ch_idx)
                        if p.regs_on:
                            self._add_regmarks_svg(dwg, p, W, H)
                        dwg.save()
            
                    QMessageBox.information(self, "Saved", f"SVG separations saved ({W_in}×{H_in} in) in folder:\n{folder}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def _add_regmarks_svg(self, dwg: svgwrite.Drawing, p: Params, w: int, h: int):
        size = p.reg_size_px; off = p.reg_offset_px
        base_t = max(1.0, size*0.06)
        t = max(0.5, base_t * p.reg_thickness_pct)
        half = size*0.5
        mc = self._reg_mark_hex()
        for ax, ay in [(off,off),(w-off,off),(w-off,h-off),(off,h-off)]:
            dwg.add(dwg.rect(insert=(ax-half, ay-half), size=(size,size), fill="none", stroke=mc, stroke_width=t))
            dwg.add(dwg.line(start=(ax-half, ay), end=(ax+half, ay), stroke=mc, stroke_width=t))
            dwg.add(dwg.line(start=(ax, ay-half), end=(ax, ay+half), stroke=mc, stroke_width=t))

    def _export_svg_channel_into(self, dwg, ink_arr: np.ndarray, p: Params, angle_deg: float, fill_color: str, channel_idx: int = 0):
        h, w = ink_arr.shape

        # Check if generative art mode is enabled
        if p.generative_enabled:
            self._export_generative_svg(dwg, ink_arr, p, fill_color, channel_idx)
            return

        # Check if ASCII art mode is enabled
        if p.ascii_enabled:
            self._export_ascii_svg(dwg, ink_arr, p, fill_color)
            return

        # Check if pixelate mode is enabled
        if p.pixelate_enabled:
            # Pixelate SVG needs all 4 CMYK arrays; they are stashed by on_export_svg
            cmyk_arrs = getattr(self, '_svg_pixelate_cmyk_arrs', None)
            if cmyk_arrs is not None:
                ch_name = ['c', 'm', 'y', 'k'][channel_idx]
                self._export_pixelate_svg(dwg, cmyk_arrs, ch_name, p, fill_color)
            return
        
        cell = p.cell
        # Apply dot gap for SVG export consistency
        cell_with_gap = cell + p.dot_gap
        grid_points = self._grid_iter(w, h, cell_with_gap, angle_deg)
        if not grid_points.any():
            return

        px, py = grid_points[:, 0].astype(int), grid_points[:, 1].astype(int)
        valid = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        sizes = ink_arr[py[valid], px[valid]]
        radii = 0.5 * cell_with_gap * p.elem * sizes

        mode = self._shape_id()

        for (x, y, _), r in zip(grid_points[valid], radii):
            if r <= 0.5:
                continue

            # ensure plain rounded floats
            cx, cy, rr = round(float(x), 3), round(float(y), 3), round(float(r), 3)

            if mode in ("circle", "dot"):
                dwg.add(dwg.circle(center=(cx, cy), r=rr, fill=fill_color))

            elif mode == "circle outline":
                dwg.add(dwg.circle(center=(cx, cy), r=rr,
                                   fill="none", stroke=fill_color, stroke_width=round(float(p.stroke), 3)))

            elif mode == "square":
                dwg.add(dwg.rect(insert=(cx-rr, cy-rr), size=(2*rr, 2*rr), fill=fill_color))

            elif mode == "diamond":
                dwg.add(dwg.rect(insert=(cx-rr, cy-rr), size=(2*rr, 2*rr),
                                 fill=fill_color, transform=f"rotate(45,{cx},{cy})"))

            elif mode == "triangle":
                dwg.add(dwg.polygon(points=[(cx, cy-rr), (cx+rr, cy+rr), (cx-rr, cy+rr)], fill=fill_color))

            elif mode == "cross":
                t = round(float(max(1.0, rr*0.5)), 3)
                dwg.add(dwg.rect(insert=(cx-t/2, cy-rr), size=(t, 2*rr), fill=fill_color))
                dwg.add(dwg.rect(insert=(cx-rr, cy-t/2), size=(2*rr, t), fill=fill_color))

            elif mode == "lines":
                # Enhanced lines export with controls
                ang = math.radians(angle_deg)
                base_line_length = 2*rr * (p.line_length_pct / 100.0)
                base_width = p.stroke * p.line_width_pct
                
                # Variable weight for SVG
                if p.line_weight_variation > 0:
                    import random
                    weight_factor = 1.0 + (random.random() - 0.5) * p.line_weight_variation * 2
                    stroke_width = base_width * weight_factor
                else:
                    stroke_width = base_width
                
                dx, dy = (base_line_length/2)*math.cos(ang), (base_line_length/2)*math.sin(ang)
                
                if p.line_taper_pct > 0:
                    # SVG tapered line using gradient stroke
                    grad_id = f"taper_{int(cx)}_{int(cy)}"
                    grad = dwg.defs.add(dwg.linearGradient(id=grad_id))
                    grad.add_stop_color(0, fill_color, opacity=p.line_taper_pct)
                    grad.add_stop_color(0.5, fill_color, opacity=1.0)
                    grad.add_stop_color(1.0, fill_color, opacity=p.line_taper_pct)
                    
                    dwg.add(dwg.line(start=(cx-dx, cy-dy), end=(cx+dx, cy+dy),
                                   stroke=f'url(#{grad_id})', stroke_width=round(float(stroke_width), 3)))
                else:
                    dwg.add(dwg.line(start=(cx-dx, cy-dy), end=(cx+dx, cy+dy),
                                   stroke=fill_color, stroke_width=round(float(stroke_width), 3)))


            elif mode == "custom" and self.shape_paths is not None and self.shape_bbox is not None:
                minx, miny, maxx, maxy = self.shape_bbox
                w0, h0 = maxx - minx, maxy - miny
                scale = (2*rr) / max(w0, h0)
                g = dwg.g(fill=fill_color, stroke="none",
                          transform=f"translate({cx},{cy}) scale({scale}) translate({- (minx + w0/2)},{- (miny + h0/2)})")
                for path in self.shape_paths:
                    g.add(dwg.path(d=path.d(), fill=fill_color, stroke="none"))
                dwg.add(g)

    def _export_pixelate_svg(self, dwg, cmyk_arrs: Dict[str, np.ndarray],
                              channel: str, p: 'Params', fill_color: str):
        """Export pixelate blocks for one channel as SVG rectangles.

        Each block allocates proportional widths to C→M→Y→K.
        Only the requested *channel*'s strip is emitted.
        """
        h, w = cmyk_arrs['c'].shape
        block = max(2, p.pixelate_block_size)
        cmyk_order = ['c', 'm', 'y', 'k']

        for by in range(0, h, block):
            y1, y2 = by, min(by + block, h)
            bh = y2 - y1
            for bx in range(0, w, block):
                x1, x2 = bx, min(bx + block, w)
                bw = x2 - x1
                if bw < 1 or bh < 1:
                    continue

                coverages = {ch: float(np.mean(cmyk_arrs[ch][y1:y2, x1:x2])) for ch in cmyk_order}

                raw_widths = {ch: coverages[ch] * bw for ch in cmyk_order}
                widths = {ch: int(round(raw_widths[ch])) for ch in cmyk_order}
                while sum(widths.values()) > bw:
                    mx = max(widths, key=lambda k: widths[k])
                    widths[mx] -= 1

                cursor_x = x1
                for ch in cmyk_order:
                    sw = widths[ch]
                    if sw <= 0:
                        cursor_x += sw
                        continue
                    strip_end = min(cursor_x + sw, x2)
                    if ch == channel and cursor_x < strip_end:
                        rx = round(float(cursor_x), 2)
                        ry = round(float(y1), 2)
                        rw_val = round(float(strip_end - cursor_x), 2)
                        rh_val = round(float(bh), 2)
                        dwg.add(dwg.rect(insert=(rx, ry), size=(rw_val, rh_val), fill=fill_color))
                    cursor_x = strip_end

    def _export_generative_svg(self, dwg, ink_arr: np.ndarray, p: 'Params', fill_color: str, channel_idx: int = 0):
        """Export generative art patterns as SVG paths"""
        h, w = ink_arr.shape
        
        line_width = max(0.5, p.generative_line_width * 3)
        
        if p.generative_mode == "flow fields":
            # Generate flow field lines
            influence_arr = ink_arr if p.flow_image_influence > 0 else None
            lines = _generate_flow_field_lines(
                w, h, p,
                arr=influence_arr,
                channel_seed=channel_idx * 12345 if p.generative_per_channel else 0
            )
            
            # Export as SVG polylines
            for line in lines:
                if len(line) < 2:
                    continue
                points = [(round(float(x), 2), round(float(y), 2)) for x, y in line]
                dwg.add(dwg.polyline(
                    points=points,
                    fill="none",
                    stroke=fill_color,
                    stroke_width=round(float(line_width), 2),
                    stroke_linecap="round",
                    stroke_linejoin="round"
                ))
                
        elif p.generative_mode == "spirograph":
            # Generate spirograph curves
            lines = _generate_spirograph(
                w, h, p,
                channel_seed=channel_idx * 12345 if p.generative_per_channel else 0
            )
            
            # Export as SVG paths
            for line in lines:
                if len(line) < 2:
                    continue
                # Build SVG path data
                d = f"M {round(line[0][0], 2)},{round(line[0][1], 2)}"
                for x, y in line[1:]:
                    d += f" L {round(x, 2)},{round(y, 2)}"
                dwg.add(dwg.path(
                    d=d,
                    fill="none",
                    stroke=fill_color,
                    stroke_width=round(float(line_width), 2),
                    stroke_linecap="round",
                    stroke_linejoin="round"
                ))
                
        elif p.generative_mode == "reaction-diffusion":
            # Generate reaction-diffusion pattern
            rd_array = _generate_reaction_diffusion(
                w, h, p,
                channel_seed=channel_idx * 12345 if p.generative_per_channel else 0,
                use_gpu=p.rd_use_gpu and HAS_CUPY
            )
            
            # Convert to contour lines
            lines = _rd_to_contour_lines(rd_array, p)
            
            # Export contour lines as SVG
            for line in lines:
                if len(line) >= 2:
                    points = [(round(float(x), 2), round(float(y), 2)) for x, y in line]
                    dwg.add(dwg.line(
                        start=points[0],
                        end=points[1],
                        stroke=fill_color,
                        stroke_width=round(float(line_width), 2)
                    ))
                    
        elif p.generative_mode == "geometric flow":
            # Generate geometric shapes
            influence_arr = ink_arr if p.flow_image_influence > 0 else None
            shapes = _generate_geometric_flow(
                w, h, p,
                arr=influence_arr,
                channel_seed=channel_idx * 12345 if p.generative_per_channel else 0
            )
            
            # Check if using custom SVG shape
            use_custom = (p.geoflow_shape == "custom" and 
                         self.shape_paths is not None and 
                         self.shape_bbox is not None)
            
            for shape in shapes:
                cx, cy = shape['cx'], shape['cy']
                size = shape['size']
                angle = shape['angle']
                pts = shape['points']
                
                if use_custom and self.shape_paths and self.shape_bbox:
                    # Export custom shape as transformed SVG path
                    minx, miny, maxx, maxy = self.shape_bbox
                    w0, h0 = maxx - minx, maxy - miny
                    if max(w0, h0) > 1e-6:
                        scale = size / max(w0, h0)
                        angle_deg = np.degrees(angle)
                        g = dwg.g(
                            fill=fill_color if p.geoflow_fill else "none",
                            stroke=fill_color if not p.geoflow_fill else "none",
                            stroke_width=round(line_width, 2) if not p.geoflow_fill else 0,
                            transform=f"translate({round(cx,2)},{round(cy,2)}) rotate({round(angle_deg,2)}) scale({round(scale,4)}) translate({round(-(minx + w0/2),2)},{round(-(miny + h0/2),2)})"
                        )
                        for path in self.shape_paths:
                            g.add(dwg.path(d=path.d()))
                        dwg.add(g)
                elif pts and len(pts) > 0 and pts[0][0] == 'circle':
                    # Circle
                    _, ccx, ccy, radius = pts[0]
                    if p.geoflow_fill:
                        dwg.add(dwg.circle(center=(round(ccx, 2), round(ccy, 2)),
                                          r=round(radius, 2),
                                          fill=fill_color, stroke="none"))
                    else:
                        dwg.add(dwg.circle(center=(round(ccx, 2), round(ccy, 2)),
                                          r=round(radius, 2),
                                          fill="none", stroke=fill_color,
                                          stroke_width=round(line_width, 2)))
                else:
                    # Polygon
                    if len(pts) >= 3:
                        svg_points = [(round(x, 2), round(y, 2)) for x, y in pts]
                        if p.geoflow_fill:
                            dwg.add(dwg.polygon(points=svg_points, fill=fill_color, stroke="none"))
                        else:
                            dwg.add(dwg.polygon(points=svg_points, fill="none", 
                                               stroke=fill_color, stroke_width=round(line_width, 2)))

    def _transform_svg_path_data(self, path_d: str, tx: float, ty: float, sx: float, sy: float) -> str:
        """Transform SVG path data by applying translate and scale mathematically.
        
        This converts path coordinates in-place rather than using SVG transform attributes,
        allowing multiple paths to be combined into a single compound path.
        
        Args:
            path_d: SVG path d attribute string
            tx, ty: Translation offset
            sx, sy: Scale factors (sy is typically negative to flip Y axis for fonts)
        
        Returns:
            Transformed path data string
        """
        import re
        
        # Parse SVG path commands and numbers
        # Commands: M, m, L, l, H, h, V, v, C, c, S, s, Q, q, T, t, A, a, Z, z
        tokens = re.findall(r'([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)', path_d)
        
        result = []
        current_cmd = None
        numbers = []
        
        def transform_point(x, y):
            """Apply scale then translate to a point."""
            return (round(x * sx + tx, 1), round(y * sy + ty, 1))
        
        def process_command():
            nonlocal numbers
            if current_cmd is None or not numbers:
                if current_cmd in ('Z', 'z'):
                    result.append('Z')
                return
            
            cmd = current_cmd
            nums = numbers
            out_parts = [cmd]
            
            if cmd in ('M', 'L', 'T'):  # Absolute moveto/lineto/smooth quadratic - pairs of (x,y)
                for i in range(0, len(nums), 2):
                    if i + 1 < len(nums):
                        nx, ny = transform_point(nums[i], nums[i+1])
                        out_parts.append(f"{nx},{ny}")
            elif cmd in ('m', 'l', 't'):  # Relative - scale only (no translate for relative)
                for i in range(0, len(nums), 2):
                    if i + 1 < len(nums):
                        nx, ny = round(nums[i] * sx, 1), round(nums[i+1] * sy, 1)
                        out_parts.append(f"{nx},{ny}")
            elif cmd == 'H':  # Absolute horizontal line
                for n in nums:
                    out_parts.append(f"{round(n * sx + tx, 1)}")
            elif cmd == 'h':  # Relative horizontal
                for n in nums:
                    out_parts.append(f"{round(n * sx, 1)}")
            elif cmd == 'V':  # Absolute vertical line
                for n in nums:
                    out_parts.append(f"{round(n * sy + ty, 1)}")
            elif cmd == 'v':  # Relative vertical
                for n in nums:
                    out_parts.append(f"{round(n * sy, 1)}")
            elif cmd in ('C', 'S'):  # Absolute cubic bezier
                for i in range(0, len(nums), 2):
                    if i + 1 < len(nums):
                        nx, ny = transform_point(nums[i], nums[i+1])
                        out_parts.append(f"{nx},{ny}")
            elif cmd in ('c', 's'):  # Relative cubic bezier
                for i in range(0, len(nums), 2):
                    if i + 1 < len(nums):
                        nx, ny = round(nums[i] * sx, 1), round(nums[i+1] * sy, 1)
                        out_parts.append(f"{nx},{ny}")
            elif cmd in ('Q',):  # Absolute quadratic bezier
                for i in range(0, len(nums), 2):
                    if i + 1 < len(nums):
                        nx, ny = transform_point(nums[i], nums[i+1])
                        out_parts.append(f"{nx},{ny}")
            elif cmd in ('q',):  # Relative quadratic bezier
                for i in range(0, len(nums), 2):
                    if i + 1 < len(nums):
                        nx, ny = round(nums[i] * sx, 1), round(nums[i+1] * sy, 1)
                        out_parts.append(f"{nx},{ny}")
            elif cmd == 'A':  # Absolute arc - (rx ry x-rotation large-arc sweep x y)
                for i in range(0, len(nums), 7):
                    if i + 6 < len(nums):
                        rx, ry = round(abs(nums[i] * sx), 1), round(abs(nums[i+1] * sy), 1)
                        rot, large, sweep = nums[i+2], int(nums[i+3]), int(nums[i+4])
                        # Flip sweep flag if Y is flipped
                        if sy < 0:
                            sweep = 1 - sweep
                        ex, ey = transform_point(nums[i+5], nums[i+6])
                        out_parts.append(f"{rx},{ry},{rot},{large},{sweep},{ex},{ey}")
            elif cmd == 'a':  # Relative arc
                for i in range(0, len(nums), 7):
                    if i + 6 < len(nums):
                        rx, ry = round(abs(nums[i] * sx), 1), round(abs(nums[i+1] * sy), 1)
                        rot, large, sweep = nums[i+2], int(nums[i+3]), int(nums[i+4])
                        if sy < 0:
                            sweep = 1 - sweep
                        ex, ey = round(nums[i+5] * sx, 1), round(nums[i+6] * sy, 1)
                        out_parts.append(f"{rx},{ry},{rot},{large},{sweep},{ex},{ey}")
            elif cmd in ('Z', 'z'):
                out_parts = ['Z']
            
            if len(out_parts) > 1 or cmd in ('Z', 'z'):
                result.append(' '.join(out_parts))
            
            numbers = []
        
        for token in tokens:
            cmd_match, num_match = token
            if cmd_match:
                # New command - process previous
                process_command()
                current_cmd = cmd_match
            elif num_match:
                numbers.append(float(num_match))
        
        # Process final command
        process_command()
        
        return ' '.join(result)

    def _export_ascii_svg(self, dwg, ink_arr: np.ndarray, p: 'Params', fill_color: str):
        """Export ASCII art as SVG using a single compound path for minimal file size.
        
        For BLOCK characters (░▒▓█), uses ultra-compact rectangle paths (~17 chars each).
        For other charsets, uses glyph outlines from font files.
        
        This creates ONE <path> element containing all shapes, making the file:
        - 95-99% smaller for block mode (rectangles vs glyph paths)
        - 70-90% smaller for other modes (compound path vs symbol/use)
        - Fast to load in Adobe Illustrator
        - No text elements (pure vector paths)
        """
        h, w = ink_arr.shape
        cell_size = int(p.ascii_cell_size)
        font_size = p.ascii_font_size
        
        # Get character set
        charset = self._get_ascii_charset(p.ascii_charset, p.ascii_custom_chars)
        num_chars = len(charset)
        if num_chars == 0:
            charset = " .:-=+*#%@"
            num_chars = len(charset)
        
        # Detect if using block characters - these can be rendered as simple rectangles
        block_chars = set('░▒▓█▀▄▌▐■□')
        unique_charset = set(charset.replace(' ', ''))
        is_block_mode = len(unique_charset) > 0 and unique_charset.issubset(block_chars)
        
        # Calculate grid dimensions
        cols = max(1, w // cell_size)
        rows = max(1, h // cell_size)
        
        # Downsample array to get average values per cell
        arr_float = ink_arr.astype(np.float32)
        arr_pil = Image.fromarray(arr_float, mode='F')
        arr_resized = np.array(arr_pil.resize((cols, rows), Image.Resampling.LANCZOS))
        
        # Apply gamma correction to preserve mid-tone and highlight detail
        gamma = 1.8
        arr_resized = np.power(np.clip(arr_resized, 0.0, 1.0), 1.0 / gamma)
        
        # Invert if needed
        if p.ascii_invert:
            arr_resized = 1.0 - arr_resized
        
        line_spacing = p.ascii_line_spacing
        num_levels = max(2, min(p.ascii_threshold_levels, num_chars))
        
        # Helper function to get character index from value
        def _get_char_idx(val):
            if p.ascii_threshold_levels <= num_chars:
                level = int(val * (num_levels - 1) + 0.5)
                level = max(0, min(num_levels - 1, level))
                char_idx = int(level * (num_chars - 1) / max(1, num_levels - 1) + 0.5)
            else:
                char_idx = int(val * (num_chars - 1) + 0.5)
            return max(0, min(num_chars - 1, char_idx))
        
        # =====================================================================
        # BLOCK MODE: Ultra-compact rectangles (~17 chars each vs 500+ for glyphs)
        # =====================================================================
        if is_block_mode:
            # Map block characters to fill percentages (how much of cell to fill)
            block_fill_map = {
                ' ': 0.0,    # Empty
                '░': 0.25,   # Light shade - 25%
                '▒': 0.50,   # Medium shade - 50%
                '▓': 0.75,   # Dark shade - 75%
                '█': 1.00,   # Full block - 100%
                '▀': 0.50,   # Upper half
                '▄': 0.50,   # Lower half
                '▌': 0.50,   # Left half
                '▐': 0.50,   # Right half
                '■': 0.80,   # Smaller full block
                '□': 0.10,   # Outline only (treat as small)
            }
            
            # Collect all rectangle paths
            all_path_segments = []
            cell_h = int(cell_size * line_spacing)
            
            for row_idx in range(rows):
                for col_idx in range(cols):
                    val = arr_resized[row_idx, col_idx]
                    char_idx = _get_char_idx(val)
                    char = charset[char_idx]
                    
                    # Skip spaces
                    if char == ' ':
                        continue
                    
                    # Get fill percentage for this block character
                    fill_pct = block_fill_map.get(char, 0.5)
                    if fill_pct <= 0:
                        continue
                    
                    # Calculate base position
                    x = col_idx * cell_size
                    y = row_idx * cell_h
                    
                    # Calculate rectangle size based on fill percentage
                    # Full blocks get full cell, partial blocks get centered smaller rect
                    if fill_pct >= 1.0:
                        # Full cell coverage
                        rx, ry = x, y
                        rw, rh = cell_size, cell_h
                    else:
                        # Centered rectangle scaled by fill percentage
                        # Use sqrt for area-based scaling (looks better)
                        scale = fill_pct ** 0.5
                        rw = int(cell_size * scale)
                        rh = int(cell_h * scale)
                        rx = x + (cell_size - rw) // 2
                        ry = y + (cell_h - rh) // 2
                        # Ensure minimum size
                        rw = max(1, rw)
                        rh = max(1, rh)
                    
                    # Ultra-compact rectangle path: M{x},{y}h{w}v{h}h{-w}Z
                    # This is ~17 characters vs 500+ for a font glyph path!
                    path_seg = f"M{rx},{ry}h{rw}v{rh}h{-rw}Z"
                    all_path_segments.append(path_seg)
            
            # Create a SINGLE compound path with all rectangles
            if all_path_segments:
                compound_path_d = "".join(all_path_segments)  # No spaces needed
                dwg.add(dwg.path(d=compound_path_d, fill=fill_color))
            
            print(f"ASCII SVG (BLOCK MODE): {len(all_path_segments)} rectangles in 1 compound path")
            return
        
        # =====================================================================
        # GLYPH MODE: Convert font glyphs to paths (original code path)
        # =====================================================================)
        
        # Find font path for path conversion
        font_path = None
        if HAS_FONTTOOLS:
            font_paths = [
                "C:/Windows/Fonts/consola.ttf",
                "C:/Windows/Fonts/cour.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
                "/System/Library/Fonts/Courier.ttf"
            ]
            for fp in font_paths:
                if os.path.exists(fp):
                    font_path = fp
                    break
        
        if not HAS_FONTTOOLS or not font_path:
            # Fallback warning - can't create paths without fonttools
            print("Warning: fonttools not installed or no font found. ASCII SVG export requires fonttools.")
            # Create a simple placeholder rectangle
            dwg.add(dwg.rect(insert=(0, 0), size=(w, h), fill="none", stroke=fill_color, stroke_width=2))
            dwg.add(dwg.text("ASCII export requires fonttools library", insert=(w/2, h/2), 
                            text_anchor="middle", font_size="24px", fill=fill_color))
            return
        
        # Pre-cache all glyph paths for used characters
        glyph_cache = {}
        for char in charset:
            if char.strip() == "":
                continue
            path_data = self._get_glyph_svg_path(char, font_path)
            if path_data:
                glyph_cache[char] = path_data
        
        # Calculate scale factor (fonts are typically 1000 units per em)
        scale = font_size / 1000.0
        
        # Collect ALL transformed path data into one compound path
        all_path_segments = []
        
        for row_idx in range(rows):
            for col_idx in range(cols):
                val = arr_resized[row_idx, col_idx]
                char_idx = _get_char_idx(val)
                char = charset[char_idx]
                
                # Skip spaces
                if char.strip() == "" or char not in glyph_cache:
                    continue
                
                # Calculate position for this glyph
                x = col_idx * cell_size
                y = int(row_idx * cell_size * line_spacing) + font_size
                
                # Get the raw glyph path data
                path_data = glyph_cache[char]
                
                # Transform the path data mathematically (scale and translate)
                # Scale by font_size/1000, flip Y axis (negative scale), then translate to position
                transformed = self._transform_svg_path_data(
                    path_data,
                    tx=x,
                    ty=y,
                    sx=scale,
                    sy=-scale  # Negative to flip Y axis (font coordinates are Y-up)
                )
                
                if transformed:
                    all_path_segments.append(transformed)
        
        # Create a SINGLE compound path element with all glyphs
        if all_path_segments:
            compound_path_d = " ".join(all_path_segments)
            dwg.add(dwg.path(d=compound_path_d, fill=fill_color))
        
        # Log stats for debugging
        print(f"ASCII SVG: {len(all_path_segments)} glyphs combined into 1 compound path")

    def on_export_pdf(self):
        if self.img_full_rgba is None and not self._layers:
            QMessageBox.warning(self, "No image", "Open an image first."); return
        if not any(l.visible for l in self._layers):
            QMessageBox.warning(self, "No visible layers", "Turn on at least one layer to export."); return
        if not any(l.visible for l in self._layers):
            QMessageBox.warning(self, "No visible layers", "Turn on at least one layer to export."); return
        base_path, _ = QFileDialog.getSaveFileName(self, "save PDF plates", self._default_save_path(self._default_filename_stem() + ".pdf"), "PDF (*.pdf)")
        if not base_path:
            return
        if base_path.lower().endswith(".pdf"):
            base_path = base_path[:-4]

        try:
            self._sync_active_layer_params_from_ui()
            p = self.params(); tr = self._get_transform()
            W_in, H_in = self._get_doc_size_in()

            # If per-layer effects are active, render through the per-layer pipeline
            # Render clean binary plates per-channel across all layers
            if self._has_per_layer_effects():
                folder = f"{base_path}_PDF_Plates"
                os.makedirs(folder, exist_ok=True)

                plates = self._render_plates_per_layer(tr)
                bg_p = self._get_bg_registration_params()

                # Apply registration marks to L-mode plates
                def _apply_regs_to_plate(plate_l):
                    if bg_p.regs_on:
                        mask = ImageChops.invert(plate_l)
                        img_rgba = Image.new("RGBA", plate_l.size, (255,255,255,255))
                        img_rgba.paste((0,0,0,255), (0,0,plate_l.width,plate_l.height), mask)
                        img_rgba = self._paste_regmarks_bitmap(img_rgba, bg_p)
                        return img_rgba.convert("L")
                    return plate_l

                # B/W halftone: export only K plate
                if p.grayscale_mode:
                    img = _apply_regs_to_plate(plates['k'])
                    img = self._upscale_for_export(img)
                    out_path = os.path.join(folder, "k.pdf")
                    if HAS_REPORTLAB and rl_canvas is not None and RL_INCH is not None and ImageReader is not None:
                        c = rl_canvas.Canvas(out_path, pagesize=(W_in*RL_INCH, H_in*RL_INCH))
                        ir = ImageReader(img.convert("RGB"))
                        c.drawImage(ir, 0, 0, width=W_in*RL_INCH, height=H_in*RL_INCH, mask='auto')
                        c.showPage(); c.save()
                    else:
                        img.convert("RGB").save(out_path, "PDF", resolution=DOC_DPI)
                    QMessageBox.information(self, "Saved", f"B/W PDF plate saved:\n{out_path}")
                else:
                    for ch in "cmyk":
                        img = _apply_regs_to_plate(plates[ch])
                        img = self._upscale_for_export(img)
                        out_path = os.path.join(folder, f"{ch}.pdf")
                        if HAS_REPORTLAB and rl_canvas is not None and RL_INCH is not None and ImageReader is not None:
                            c = rl_canvas.Canvas(out_path, pagesize=(W_in*RL_INCH, H_in*RL_INCH))
                            ir = ImageReader(img.convert("RGB"))
                            c.drawImage(ir, 0, 0, width=W_in*RL_INCH, height=H_in*RL_INCH, mask='auto')
                            c.showPage(); c.save()
                        else:
                            img.convert("RGB").save(out_path, "PDF", resolution=DOC_DPI)
                    QMessageBox.information(self, "Saved", f"PDF separations saved in folder:\n{folder}")
                return

            art_rgba = self._artboard_rgba_cached(tr)
            art_trans = self._artboard_rgba_transparent(tr)
            art_key = self._art_key(tr)

            folder = f"{base_path}_PDF_Plates"
            os.makedirs(folder, exist_ok=True)

            # Check if grayscale mode is enabled
            if p.grayscale_mode:
                # Export only K (black) channel for grayscale mode
                arr = self._arr_gray_cached(tr, p.invert_gray)
                arr = self._apply_slice_shift(arr, p)
                arr = self._apply_vertical_slice_shift(arr, p)
                arr = self._apply_smear_drag(arr, p, 0)
                arr = self._apply_macroblock_corruption(arr, p, 0)
                arr = self._apply_halftone_slice_shift(arr, p)
                arr = self._apply_halftone_vertical_slice_shift(arr, p)
                arr = self._maybe_dither_arr(arr, p)

                if p.diffusion_enabled and p.diffusion_intensity > 0:
                    # Diffusion mode — coverage IS the output, skip halftone dots
                    h_px, w_px = arr.shape
                    k_uint8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
                    mask = Image.fromarray(k_uint8)
                    img = Image.new("L", (w_px, h_px), 255)
                    img.paste(0, mask=mask)
                else:
                    plate = self._render_plate_from_arr(arr, p, p.ang_k, exact_cell=True)
                    plate = self._apply_displacement({'k': plate}, p)['k']

                    mask = plate.getchannel("A")
                    img = Image.new("L", plate.size, 255)
                    img.paste(0, mask=mask)

                if p.regs_on:
                    # build RGBA with reg marks then convert back to L
                    img_rgba = Image.new("RGBA", img.size, (255, 255, 255, 255))
                    img_rgba.paste((0, 0, 0, 255), (0, 0, img.width, img.height), mask)
                    img_rgba = self._paste_regmarks_bitmap(img_rgba, p)
                    img = img_rgba.convert("L")

                img = self._upscale_for_export(img)
                out_path = os.path.join(folder, "k.pdf")
                if HAS_REPORTLAB and rl_canvas is not None and RL_INCH is not None and ImageReader is not None:
                    c = rl_canvas.Canvas(out_path, pagesize=(W_in*RL_INCH, H_in*RL_INCH))
                    ir = ImageReader(img.convert("RGB"))
                    c.drawImage(ir, 0, 0, width=W_in*RL_INCH, height=H_in*RL_INCH, mask='auto')
                    c.showPage(); c.save()
                else:
                    img.convert("RGB").save(out_path, "PDF", resolution=DOC_DPI)
                
                QMessageBox.information(self, "Saved", f"B/W PDF plate saved:\n{out_path}")
            else:
                # Check if single channel mode (full composite unchecked)
                if not self.full_comp.isChecked():
                    # Export only the selected preview channel
                    ch = p.preview_channel if p.preview_channel != "composite" else "k"
                    ang = getattr(p, f"ang_{ch}")
                    _ch_idx_map_sc = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                    
                    arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
                    arr = self._apply_slice_shift(arr, p)
                    arr = self._apply_vertical_slice_shift(arr, p)
                    arr = self._apply_smear_drag(arr, p, _ch_idx_map_sc.get(ch, 0))
                    arr = self._apply_macroblock_corruption(arr, p, _ch_idx_map_sc.get(ch, 0))
                    arr = self._apply_halftone_slice_shift(arr, p)
                    arr = self._apply_halftone_vertical_slice_shift(arr, p)
                    arr = self._maybe_dither_arr(arr, p, _ch_idx_map_sc.get(ch, 0))

                    if p.diffusion_enabled and p.diffusion_intensity > 0:
                        h_px, w_px = arr.shape
                        ch_uint8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
                        mask = Image.fromarray(ch_uint8)
                        img = Image.new("L", (w_px, h_px), 255)
                        img.paste(0, mask=mask)
                    else:
                        plate = self._render_plate_from_arr(arr, p, ang, None, _ch_idx_map_sc.get(ch, 0), exact_cell=True)
                        plate = self._apply_displacement({ch: plate}, p)[ch]

                        mask = plate.getchannel("A")
                        img = Image.new("L", plate.size, 255)
                        img.paste(0, mask=mask)

                    if p.regs_on:
                        # build RGBA with reg marks then convert back to L
                        img_rgba = Image.new("RGBA", img.size, (255, 255, 255, 255))
                        img_rgba.paste((0, 0, 0, 255), (0, 0, img.width, img.height), mask)
                        img_rgba = self._paste_regmarks_bitmap(img_rgba, p)
                        img = img_rgba.convert("L")

                    img = self._upscale_for_export(img)
                    out_path = os.path.join(folder, f"{ch}.pdf")
                    if HAS_REPORTLAB and rl_canvas is not None and RL_INCH is not None and ImageReader is not None:
                        c = rl_canvas.Canvas(out_path, pagesize=(W_in*RL_INCH, H_in*RL_INCH))
                        ir = ImageReader(img.convert("RGB"))
                        c.drawImage(ir, 0, 0, width=W_in*RL_INCH, height=H_in*RL_INCH, mask='auto')
                        c.showPage(); c.save()
                    else:
                        img.convert("RGB").save(out_path, "PDF", resolution=DOC_DPI)

                    QMessageBox.information(self, "Saved", f"Single channel ({ch.upper()}) PDF plate saved:\n{out_path}")
                else:
                    # Export all CMYK channels for color mode
                    _ch_idx_map_full = {'c': 0, 'm': 1, 'y': 2, 'k': 3}
                    for ch, ang in zip("cmyk", (p.ang_c, p.ang_m, p.ang_y, p.ang_k)):
                        arr = self._arr_cmyk_cached(art_key, art_trans, ch, p.invert_gray)
                        arr = self._apply_slice_shift(arr, p)
                        arr = self._apply_vertical_slice_shift(arr, p)
                        arr = self._apply_smear_drag(arr, p, _ch_idx_map_full.get(ch, 0))
                        arr = self._apply_macroblock_corruption(arr, p, _ch_idx_map_full.get(ch, 0))
                        arr = self._apply_halftone_slice_shift(arr, p)
                        arr = self._apply_halftone_vertical_slice_shift(arr, p)
                        arr = self._maybe_dither_arr(arr, p, _ch_idx_map_full.get(ch, 0))

                        if p.diffusion_enabled and p.diffusion_intensity > 0:
                            h_px, w_px = arr.shape
                            ch_uint8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
                            mask = Image.fromarray(ch_uint8)
                            img = Image.new("L", (w_px, h_px), 255)
                            img.paste(0, mask=mask)
                        else:
                            plate = self._render_plate_from_arr(arr, p, ang, None, _ch_idx_map_full.get(ch, 0), exact_cell=True)
                            plate = self._apply_displacement({ch: plate}, p)[ch]

                            mask = plate.getchannel("A")
                            img = Image.new("L", plate.size, 255)
                            img.paste(0, mask=mask)

                        if p.regs_on:
                            # build RGBA with reg marks then convert back to L
                            img_rgba = Image.new("RGBA", img.size, (255, 255, 255, 255))
                            img_rgba.paste((0, 0, 0, 255), (0, 0, img.width, img.height), mask)
                            img_rgba = self._paste_regmarks_bitmap(img_rgba, p)
                            img = img_rgba.convert("L")

                        img = self._upscale_for_export(img)
                        out_path = os.path.join(folder, f"{ch}.pdf")
                        if HAS_REPORTLAB and rl_canvas is not None and RL_INCH is not None and ImageReader is not None:
                            c = rl_canvas.Canvas(out_path, pagesize=(W_in*RL_INCH, H_in*RL_INCH))
                            ir = ImageReader(img.convert("RGB"))
                            c.drawImage(ir, 0, 0, width=W_in*RL_INCH, height=H_in*RL_INCH, mask='auto')
                            c.showPage(); c.save()
                        else:
                            img.convert("RGB").save(out_path, "PDF", resolution=DOC_DPI)

                    QMessageBox.information(self, "Saved", f"PDF separations saved in folder:\n{folder}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def _save_image_as_pdf(self, img_rgba: Image.Image, pdf_path: str, width_in: float, height_in: float, dpi: int):
        target_w, target_h = int(round(width_in*dpi)), int(round(height_in*dpi))
        if img_rgba.size != (target_w, target_h):
            img_rgba = img_rgba.resize((target_w, target_h), Image.Resampling.LANCZOS)
        if HAS_REPORTLAB and rl_canvas is not None and RL_INCH is not None and ImageReader is not None:
            c = rl_canvas.Canvas(pdf_path, pagesize=(width_in*RL_INCH, height_in*RL_INCH))
            ir = ImageReader(img_rgba.convert("RGB"))
            c.drawImage(ir, 0, 0, width=width_in*RL_INCH, height=height_in*RL_INCH, mask='auto')
            c.showPage(); c.save()
        else:
            img_rgba.convert("RGB").save(pdf_path, "PDF", resolution=dpi)

    def _delayed_render(self):
        """Delayed rendering method for timer"""
        if hasattr(self, 'update_preview'):
            self.update_preview(force=True)

    def _render_halftone(self):
        """Main halftone rendering method"""
        # This is now handled by update_preview method
        self.update_preview(force=True)

    def _on_screenshot(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "save screenshot",
            self._default_save_path(self._default_filename_stem() + "_screenshot.png"),
            "PNG (*.png)")
        if not path: return
        if not path.lower().endswith(".png"):
            path += ".png"
        screen = QApplication.primaryScreen()
        pixmap = screen.grabWindow(int(self.winId()))
        pixmap.save(path, "PNG")
        self.statusBar().showMessage(f"screenshot saved: {path}", 4000)

    def _on_record_toggle(self):
        if getattr(self, '_recorder', None) is None:
            self._start_recording()
        else:
            self._stop_recording()

    def _start_recording(self):
        if not HAS_OPENCV or cv2 is None: return
        geo = self.geometry()
        w = geo.width() & ~1
        h = geo.height() & ~1
        fps = 30.0
        # Write to a temp MP4 file using mp4v codec
        fd, tmp_path = tempfile.mkstemp(suffix="_recording.mp4")
        os.close(fd)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")  # type: ignore[union-attr]
        self._recorder = cv2.VideoWriter(tmp_path, fourcc, fps, (w, h))  # type: ignore[union-attr]
        if not self._recorder.isOpened():  # type: ignore[union-attr]
            self._recorder = None
            os.unlink(tmp_path)
            self.statusBar().showMessage("error: could not open video writer", 4000)
            return
        self._record_tmp_path = tmp_path
        self._record_size = (w, h)
        self._record_timer = QTimer(self)
        self._record_timer.setInterval(int(1000 / fps))
        self._record_timer.timeout.connect(self._grab_record_frame)
        self._record_timer.start()
        self.record_btn.setText("■  stop")
        self.record_btn.setStyleSheet(
            "background:#993300; color:#fff; border:1px solid #cc4400; border-radius:6px; padding:6px 10px;")
        self.statusBar().showMessage("recording…")

    def _grab_record_frame(self):
        if getattr(self, '_recorder', None) is None: return
        screen = QApplication.primaryScreen()
        geo = self.geometry()
        pixmap = screen.grabWindow(0, geo.x(), geo.y(), geo.width(), geo.height())
        img = pixmap.toImage().convertToFormat(QImage.Format.Format_RGB888)  # type: ignore[attr-defined]
        w, h = getattr(self, '_record_size', (img.width() & ~1, img.height() & ~1))
        ptr = img.constBits()
        arr = np.frombuffer(ptr, dtype=np.uint8).reshape((img.height(), img.width(), 3)).copy()
        bgr = arr[:h, :w, ::-1]
        self._recorder.write(bgr)  # type: ignore[union-attr]

    def _stop_recording(self):
        timer = getattr(self, '_record_timer', None)
        if timer is not None:
            timer.stop()
            self._record_timer = None
        rec = getattr(self, '_recorder', None)
        if rec is not None:
            rec.release()
            self._recorder = None
        self.record_btn.setText("●  record")
        self.record_btn.setStyleSheet("")
        tmp_path = getattr(self, '_record_tmp_path', '')
        if not tmp_path or not os.path.exists(tmp_path):
            self.statusBar().showMessage("recording discarded", 4000)
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "save recording",
            self._default_save_path(self._default_filename_stem() + "_recording.mp4"),
            "MP4 (*.mp4)")
        if not path:
            os.unlink(tmp_path)
            self._record_tmp_path = ''
            self.statusBar().showMessage("recording discarded", 4000)
            return
        if not path.lower().endswith(".mp4"):
            path += ".mp4"
        shutil.move(tmp_path, path)
        self._record_tmp_path = ''
        self.statusBar().showMessage(f"recording saved: {path}", 5000)
        QMessageBox.information(self, "recording saved", f"video saved:\n{path}")

    def closeEvent(self, event):
        msg = QMessageBox(self)
        msg.setWindowTitle("Save before closing?")
        msg.setText("Do you want to save your progress before closing?")
        msg.setIcon(QMessageBox.Icon.Question)
        save_btn = msg.addButton("Save", QMessageBox.ButtonRole.AcceptRole)
        discard_btn = msg.addButton("Don't Save", QMessageBox.ButtonRole.DestructiveRole)
        cancel_btn = msg.addButton("Cancel", QMessageBox.ButtonRole.RejectRole)
        msg.setDefaultButton(cancel_btn)
        msg.exec()
        clicked = msg.clickedButton()
        if clicked == save_btn:
            self.on_save_project()
            event.accept()
        elif clicked == discard_btn:
            event.accept()
        else:
            event.ignore()

def _set_win_appusermodelid(app_id: str = "com.halftoneglitch.app.v2"):
    try:
        if sys.platform.startswith("win"):
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        pass

def main():
    _set_win_appusermodelid()
    app = QApplication(sys.argv)
    app.setApplicationName("halftone_glitch_v2")
    app.setStyleSheet(QSS)
    ic = _load_app_icon()
    if ic: app.setWindowIcon(ic)

    main_win: Dict[str, Optional[Main]] = {'value': None}  # mutable container for closure

    def _on_dialog_accepted(settings: dict):
        if settings.get('resume'):
            # Resume from auto-save
            w = Main()
            try:
                with open(_autosave_path(), 'r', encoding='utf-8') as f:
                    data = json.load(f)
                w._load_project_dict(data)
                w._project_path = _autosave_path()
                w.statusBar().showMessage("resumed from last session")
            except Exception:
                w.statusBar().showMessage("failed to resume — starting fresh")
        else:
            w = Main(doc_settings=settings)
            # Set auto-save to the dedicated file
            w._project_path = _autosave_path()
        main_win['value'] = w
        w.resize(1460, 940)
        w.show()

    def _on_dialog_cancelled():
        if main_win['value'] is None:
            app.quit()

    dlg = NewDocumentDialog()
    dlg.accepted.connect(_on_dialog_accepted)
    dlg.cancelled.connect(_on_dialog_cancelled)
    dlg.show()

    sys.exit(app.exec())

if __name__ == "__main__":
    main()