// =============================================================================
// plot-3d.js  —  3D Failure Envelope + Real-Time Calculation Playback Engine
// Depends on: state.js, materials.js, geometry.js, interaction-diagram.js
// =============================================================================

// ── Shared state ──────────────────────────────────────────────────────────────
let calculatedPoints3D = [];
let lastHoveredPtInfo  = { theta: 0, Xu: 150, Mx: 0, My: 0, Pu: 0 };

// Animation state (set by render3DPlot, consumed by startProcessAnimation)
let _animRunning   = false;
let _animShouldRun = false;
let _animScale     = 1;
let _animCenterZ   = 0;
let _animColHeight = 0;
let _animFloorZ    = 0;

// ── Shared angle → color mapping (hue gradient used for both the failure-
//    surface mesh and the live scatter trace) ─────────────────────────────────
// Stops: [t (0–1 along 0°–350°), hue, saturation%, lightness%]
const _HSV_STOPS = [
    [0,     0,   90, 60], [0.056, 20,  90, 60],
    [0.111, 40,  90, 60], [0.167, 60,  90, 58],
    [0.222, 80,  90, 55], [0.278, 120, 90, 52],
    [0.333, 155, 90, 50], [0.389, 180, 90, 50],
    [0.444, 200, 90, 55], [0.5,   220, 90, 60],
    [0.556, 240, 90, 62], [0.611, 260, 90, 62],
    [0.667, 280, 90, 62], [0.722, 300, 90, 60],
    [0.778, 320, 90, 60], [0.833, 340, 90, 60],
    [1,     360, 90, 60]
];

// Plotly colorscale form (for the mesh3d surface trace, which supports colorscales fine)
function _hsvColorscale() {
    return _HSV_STOPS.map(([t, h, s, l]) => [t, `hsl(${h},${s}%,${l}%)`]);
}

function _hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

// Interpolate hue/sat/light for a bending angle (0–350°) and bake the given
// opacity directly into an rgba() string. Plotly's scatter3d does NOT reliably
// honor per-point marker.opacity arrays, so opacity must be encoded in the
// color itself to actually render per-point fading.
function _angleToRGBA(angleDeg, opacity) {
    const t = Math.max(0, Math.min(1, angleDeg / 350));
    let lo = _HSV_STOPS[0], hi = _HSV_STOPS[_HSV_STOPS.length - 1];
    for (let i = 0; i < _HSV_STOPS.length - 1; i++) {
        if (t >= _HSV_STOPS[i][0] && t <= _HSV_STOPS[i + 1][0]) {
            lo = _HSV_STOPS[i]; hi = _HSV_STOPS[i + 1]; break;
        }
    }
    const span = hi[0] - lo[0];
    const f = span > 0 ? (t - lo[0]) / span : 0;
    const h = lo[1] + f * (hi[1] - lo[1]);
    const s = lo[2] + f * (hi[2] - lo[2]);
    const l = lo[3] + f * (hi[3] - lo[3]);
    const [r, g, b] = _hslToRgb(h, s, l);
    return `rgba(${r},${g},${b},${opacity.toFixed(3)})`;
}

// ── Xu sweep list for one angle ───────────────────────────────────────────────
function _xuList(extent) {
    const divisions = 40;
    const out = [];
    for (let i = divisions; i >= -Math.floor(divisions / 5); i--) {
        let xu;
        if      (i > divisions * 0.8) xu = extent + (i - divisions*0.8)*(9*extent)/(divisions*0.2);
        else if (i >= 0)              xu = 0.05*extent + i*(0.95*extent)/(divisions*0.8);
        else                          xu = 0.01*extent + (i+divisions/5)*(0.04*extent)/(divisions/5);
        out.push(Math.round(xu * 10) / 10);
    }
    return out;
}

// ── Build per-angle geometry context ─────────────────────────────────────────
function _buildAngleContext(theta) {
    const cx = maxX / 2, cy = maxY / 2;
    let extent, rotatedVertices, rotatedBars, minY = 0;

    if (sectionType === 'circular') {
        extent = maxY;
        rotatedBars = circles.map(c => {
            const r = rotatePoint(c.x, c.y, cx, cy, theta);
            return { ...c, x: r.x, y: r.y };
        });
        rotatedVertices = null;
    } else {
        const rg = getRotatedRectVertices(maxX, maxY, theta);
        rotatedVertices = rg.vertices;
        extent = rg.extent;
        const corners = [{x:0,y:0},{x:maxX,y:0},{x:maxX,y:maxY},{x:0,y:maxY}]
            .map(p => rotatePoint(p.x, p.y, cx, cy, theta));
        minY = Math.min(...corners.map(p => p.y));
        rotatedBars = circles.map(c => {
            const r = rotatePoint(c.x, c.y, cx, cy, theta);
            return { ...c, x: r.x, y: r.y - minY };
        });
    }
    return { extent, rotatedVertices, rotatedBars, minY, cx, cy };
}

// ── Compute one (theta, Xu) capacity point ────────────────────────────────────
function _computeOnePoint(theta, Xu, extent, rotatedVertices, rotatedBars, minY) {
    const origMaxX = maxX, origMaxY = maxY, origCircles = circles,
          origST   = sectionType, origGW = getSectionWidthAtDepth;

    maxX = extent; maxY = extent; circles = rotatedBars;
    if (origST === 'circular') {
        getSectionWidthAtDepth = y => {
            const R = extent / 2;
            if (y < 0 || y > extent) return 0;
            return 2 * Math.sqrt(R*R - Math.pow(y - R, 2));
        };
    } else {
        getSectionWidthAtDepth = y => polygonWidthAtY(rotatedVertices, y);
    }

    const result = initSectionForXu(Xu);

    maxX = origMaxX; maxY = origMaxY; circles = origCircles;
    sectionType = origST; getSectionWidthAtDepth = origGW;

    const Cc = result.concrete.CFc;
    let Cs_net = 0, Ts_net = 0;
    result.data.forEach(d => {
        if (d.reducedForce >= 0) Cs_net += d.reducedForce * 1e-3;
        else                      Ts_net += Math.abs(d.reducedForce) * 1e-3;
    });

    const e_top = linearStrainCompatibilityInColumn(extent, Xu, extent);
    const e_bot = linearStrainCompatibilityInColumn(extent, Xu, 0);

    return {
        Mx:  result.MOR * Math.cos(theta),
        My:  result.MOR * Math.sin(theta),
        Pu:  result.CF,
        MOR: result.MOR,
        Cc, Cs_net, Ts_net, e_top, e_bot
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// COLUMN MODEL  —  FIXED body, ROTATING NA plane
//
// Coordinate convention (matches failure-surface axes):
//   Physical Y  →  Plot X axis  (Mx bending direction)
//   Physical X  →  Plot Y axis  (My bending direction)
//   toPlot(phys_x, phys_y) => { x: phys_y * scale,  y: phys_x * scale }
//
// The column body is NEVER rotated.
// The neutral axis is the line:  phys_x·sinθ + phys_y·cosθ = d
//   where d = extent/2 − Xu   (in centred physical coordinates)
// ═════════════════════════════════════════════════════════════════════════════
function getCenteredColumnTraces(theta, Xu, scale, centerZ, H) {
    const hHalf = H / 2;
    const sinT  = Math.sin(theta);
    const cosT  = Math.cos(theta);
    const bHalf = maxX / 2;   // half-width  (physical X)
    const dHalf = maxY / 2;   // half-depth  (physical Y)

    // Convert physical centred (px, py) → plot (x, y)
    const toPlot = (px, py) => ({ x: py * scale, y: px * scale });

    // ── 1. FIXED column body ──────────────────────────────────────────────────
    let concreteX=[], concreteY=[], concreteZ=[];
    let concreteI=[], concreteJ=[], concreteK=[];

    if (sectionType === 'circular') {
        const R = maxY / 2;
        const Nc = 32;
        for (let n = 0; n < Nc; n++) {
            const alpha = n * 2 * Math.PI / Nc;
            const p = toPlot(R*Math.cos(alpha), R*Math.sin(alpha));
            concreteX.push(p.x, p.x);
            concreteY.push(p.y, p.y);
            concreteZ.push(centerZ - hHalf, centerZ + hHalf);
        }
        const bC = Nc*2, tC = Nc*2+1;
        concreteX.push(0, 0); concreteY.push(0, 0);
        concreteZ.push(centerZ - hHalf, centerZ + hHalf);
        for (let n = 0; n < Nc; n++) {
            const nn=(n+1)%Nc, b0=n*2, b1=nn*2, t0=n*2+1, t1=nn*2+1;
            concreteI.push(b0, b1, bC, tC);
            concreteJ.push(b1, t1, b1, t0);
            concreteK.push(t0, t0, b0, t1);
        }
    } else {
        // Rectangle — 4 corners, bottom then top
        const corners = [
            toPlot(-bHalf, -dHalf), toPlot( bHalf, -dHalf),
            toPlot( bHalf,  dHalf), toPlot(-bHalf,  dHalf)
        ];
        for (const c of corners) { concreteX.push(c.x); concreteY.push(c.y); concreteZ.push(centerZ - hHalf); }
        for (const c of corners) { concreteX.push(c.x); concreteY.push(c.y); concreteZ.push(centerZ + hHalf); }
        concreteI = [0,0,3,3, 0,0,1,1, 0,0, 4,4];
        concreteJ = [1,5,2,6, 3,7,2,6, 1,2, 5,6];
        concreteK = [5,4,6,7, 7,4,6,5, 2,3, 6,7];
    }

    // ── 2. FIXED rebars ───────────────────────────────────────────────────────
    const rebarsX=[], rebarsY=[], rebarsZ=[];
    circles.forEach(bar => {
        const p = toPlot(bar.x - maxX/2, bar.y - maxY/2);
        rebarsX.push(p.x, p.x, null);
        rebarsY.push(p.y, p.y, null);
        rebarsZ.push(centerZ - hHalf, centerZ + hHalf, null);
    });

    // ── 3. ROTATING NA plane ─────────────────────────────────────────────────
    //   Compression direction (physical centred): u = (sinθ, cosθ)
    //   Extent in that direction:
    //     rect  = B|sinθ| + D|cosθ|   (= width of bounding box perpendicular to NA)
    //     circle= diameter
    //   NA line:  px·sinθ + py·cosθ = d,   d = extent/2 − Xu

    let naIpts = [];
    let extent;

    if (sectionType === 'circular') {
        const R = maxY / 2;
        extent   = 2 * R;
        const d  = R - Xu;
        if (Math.abs(d) <= R) {
            const halfL = Math.sqrt(R*R - d*d);
            // Centre of chord in physical space: d·(sinθ, cosθ)
            // Chord direction (⊥ to compression): (−cosθ, sinθ)
            naIpts = [
                toPlot(d*sinT + halfL*(-cosT), d*cosT + halfL*sinT),
                toPlot(d*sinT - halfL*(-cosT), d*cosT - halfL*sinT)
            ];
        }
    } else {
        extent  = maxX * Math.abs(sinT) + maxY * Math.abs(cosT);
        const d = extent / 2 - Xu;
        const eps = 1e-9;
        const found = [];

        // Intersect NA line (px·sinθ + py·cosθ = d) with each rectangle edge
        // Right edge:  px = +bHalf
        if (Math.abs(cosT) > eps) {
            const py = (d - bHalf*sinT) / cosT;
            if (py >= -dHalf - eps && py <= dHalf + eps)
                found.push({ px: bHalf, py: Math.max(-dHalf, Math.min(dHalf, py)) });
        }
        // Left edge:   px = −bHalf
        if (Math.abs(cosT) > eps) {
            const py = (d + bHalf*sinT) / cosT;
            if (py >= -dHalf - eps && py <= dHalf + eps)
                found.push({ px: -bHalf, py: Math.max(-dHalf, Math.min(dHalf, py)) });
        }
        // Top edge:    py = +dHalf
        if (Math.abs(sinT) > eps) {
            const px = (d - dHalf*cosT) / sinT;
            if (px >= -bHalf - eps && px <= bHalf + eps)
                found.push({ px: Math.max(-bHalf, Math.min(bHalf, px)), py: dHalf });
        }
        // Bottom edge: py = −dHalf
        if (Math.abs(sinT) > eps) {
            const px = (d + dHalf*cosT) / sinT;
            if (px >= -bHalf - eps && px <= bHalf + eps)
                found.push({ px: Math.max(-bHalf, Math.min(bHalf, px)), py: -dHalf });
        }

        // Deduplicate corners
        const uniq = [];
        for (const p of found) {
            if (!uniq.some(u => Math.hypot(u.px - p.px, u.py - p.py) < 0.5))
                uniq.push(p);
        }
        if (uniq.length >= 2)
            naIpts = uniq.slice(0, 2).map(p => toPlot(p.px, p.py));
    }

    // NA plane mesh dropped — show only a single line at column mid-height
    const naPlaneX=[], naPlaneY=[], naPlaneZ=[], naPlaneI=[], naPlaneJ=[], naPlaneK=[];
    let naLineX=[], naLineY=[], naLineZ=[];

    if (naIpts.length >= 2) {
        const [p1, p2] = naIpts;
        // Single horizontal line at the mid-height of the column
        naLineX = [p1.x, p2.x];
        naLineY = [p1.y, p2.y];
        naLineZ = [centerZ, centerZ];
    }

    // ── 4. COMPRESSION BLOCK (Sutherland-Hodgman on FIXED polygon) ───────────
    let cbX=[], cbY=[], cbZ=[], cbI=[], cbJ=[], cbK=[];
    let compVerts = [];

    if (sectionType === 'circular') {
        const R = maxY / 2, d = R - Xu;
        const Nc2 = 64;
        for (let n = 0; n < Nc2; n++) {
            const alpha = n * 2 * Math.PI / Nc2;
            const px = R*Math.cos(alpha), py = R*Math.sin(alpha);
            if (px*sinT + py*cosT >= d - 1e-6) compVerts.push({ px, py });
        }
        if (Math.abs(d) <= R) {
            const halfL = Math.sqrt(R*R - d*d);
            compVerts.push({ px: d*sinT + halfL*(-cosT), py: d*cosT + halfL*sinT });
            compVerts.push({ px: d*sinT - halfL*(-cosT), py: d*cosT - halfL*sinT });
        }
    } else {
        const d = extent / 2 - Xu;
        // Rectangle corners (centred physical)
        const poly = [
            { px: -bHalf, py: -dHalf }, { px:  bHalf, py: -dHalf },
            { px:  bHalf, py:  dHalf }, { px: -bHalf, py:  dHalf }
        ];
        // Clip with half-plane: px·sinθ + py·cosθ >= d
        const N = poly.length;
        for (let i = 0; i < N; i++) {
            const cur = poly[i], nxt = poly[(i+1)%N];
            const dc = cur.px*sinT + cur.py*cosT;
            const dn = nxt.px*sinT + nxt.py*cosT;
            if (dc >= d) compVerts.push(cur);
            if ((dc >= d) !== (dn >= d)) {
                const t = (d - dc) / (dn - dc);
                compVerts.push({ px: cur.px + t*(nxt.px-cur.px), py: cur.py + t*(nxt.py-cur.py) });
            }
        }
    }

    if (compVerts.length >= 3) {
        const M = compVerts.length;
        const pts = compVerts.map(v => toPlot(v.px, v.py));
        for (const p of pts) { cbX.push(p.x); cbY.push(p.y); cbZ.push(centerZ - hHalf); }
        for (const p of pts) { cbX.push(p.x); cbY.push(p.y); cbZ.push(centerZ + hHalf); }
        for (let m = 0; m < M; m++) {
            const nm = (m+1)%M;
            cbI.push(m, nm); cbJ.push(nm, nm+M); cbK.push(m+M, m+M);
        }
        for (let m = 1; m < M - 1; m++) {
            cbI.push(0, M); cbJ.push(m+1, M+m); cbK.push(m, M+m+1);
        }
    }

    return {
        concrete:  { x:concreteX, y:concreteY, z:concreteZ, i:concreteI, j:concreteJ, k:concreteK },
        rebars:    { x:rebarsX,   y:rebarsY,   z:rebarsZ   },
        naPlane:   { x:naPlaneX,  y:naPlaneY,  z:naPlaneZ,  i:naPlaneI,  j:naPlaneJ,  k:naPlaneK  },
        naLine:    { x:naLineX,   y:naLineY,   z:naLineZ   },
        compBlock: { x:cbX,       y:cbY,       z:cbZ,       i:cbI,       j:cbJ,       k:cbK       }
    };
}

// ── DOM live-value updater ─────────────────────────────────────────────────────
function _updateLivePanel(theta, Xu, result, angleDeg, totalAngles, xuIdx, totalXu) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('lv-theta', `${angleDeg}°`);
    set('lv-xu',    `${Xu.toFixed(1)} mm`);
    set('lv-pu',    `${result.Pu.toFixed(1)} kN`);
    set('lv-mu',    `${result.MOR.toFixed(2)} kNm`);
    set('lv-mx',    `${result.Mx.toFixed(2)} kNm`);
    set('lv-my',    `${result.My.toFixed(2)} kNm`);
    set('lv-cc',    `${result.Cc.toFixed(1)} kN`);
    set('lv-cs',    `${result.Cs_net.toFixed(1)} kN`);
    set('lv-ts',    `${result.Ts_net.toFixed(1)} kN`);
    set('lv-etop',  `${(result.e_top * 1000).toFixed(2)}‰`);
    set('lv-ebot',  `${(result.e_bot * 1000).toFixed(2)}‰`);

    const angPct = (angleDeg / ((totalAngles-1) * 10)) * 100;
    const xuPct  = (xuIdx / (totalXu - 1)) * 100;
    const b1 = document.getElementById('lv-angle-bar');
    const b2 = document.getElementById('lv-xu-bar');
    if (b1) b1.style.width = angPct + '%';
    if (b2) b2.style.width = xuPct  + '%';
}

// ── Main pre-compute path ─────────────────────────────────────────────────────
function generate3DSurfaceData(progressCallback) {
    const numAngles = 36;
    const origMaxX=maxX, origMaxY=maxY, origCircles=circles,
          origST=sectionType, origGW=getSectionWidthAtDepth;

    const xPoints=[], yPoints=[], zPoints=[], thetaDeg=[];
    calculatedPoints3D = [];

    for (let aIdx = 0; aIdx < numAngles; aIdx++) {
        const theta    = aIdx * 10 * Math.PI / 180;
        const angleDeg = aIdx * 10;
        const ctx      = _buildAngleContext(theta);
        const xuList   = _xuList(ctx.extent);

        for (const xu of xuList) {
            try {
                const r = _computeOnePoint(theta, xu, ctx.extent, ctx.rotatedVertices, ctx.rotatedBars, ctx.minY);
                if (!isNaN(r.Pu) && !isNaN(r.Mx)) {
                    xPoints.push(r.Mx); yPoints.push(r.My); zPoints.push(r.Pu); thetaDeg.push(angleDeg);
                    calculatedPoints3D.push({ theta, Xu: xu, Mx: r.Mx, My: r.My, Pu: r.Pu });
                } else {
                    xPoints.push(0); yPoints.push(0); zPoints.push(0); thetaDeg.push(angleDeg);
                    calculatedPoints3D.push({ theta, Xu: xu, Mx: 0, My: 0, Pu: 0 });
                }
            } catch(e) {
                xPoints.push(0); yPoints.push(0); zPoints.push(0); thetaDeg.push(angleDeg);
                calculatedPoints3D.push({ theta, Xu: xu, Mx: 0, My: 0, Pu: 0 });
            }
        }
        if (progressCallback) progressCallback(Math.round((aIdx+1)/numAngles*100));
    }

    maxX=origMaxX; maxY=origMaxY; circles=origCircles;
    sectionType=origST; getSectionWidthAtDepth=origGW;

    const ppa = _xuList(1).length;
    const iIdx=[], jIdx=[], kIdx=[];
    for (let a = 0; a < numAngles; a++) {
        const na = (a+1) % numAngles;
        for (let d = 0; d < ppa-1; d++) {
            const p00=a*ppa+d, p10=na*ppa+d, p01=a*ppa+(d+1), p11=na*ppa+(d+1);
            iIdx.push(p00, p00); jIdx.push(p10, p11); kIdx.push(p11, p01);
        }
    }
    return { x:xPoints, y:yPoints, z:zPoints, i:iIdx, j:jIdx, k:kIdx, thetaDeg };
}

// ── Real-time step-by-step playback engine ────────────────────────────────────
async function startProcessAnimation(scale, centerZ, colHeight) {
    _animRunning = true;
    _animShouldRun = true;

    const speedEl   = document.getElementById('animSpeed');

    // Wipe live scatter (Trace 10) and path line (Trace 9)
    Plotly.restyle('plotlyPlot3D', { x:[[]], y:[[]], z:[[]], 'marker.color':[[]], customdata:[[]], visible:true }, [10]);
    Plotly.restyle('plotlyPlot3D', { x:[[]], y:[[]], z:[[]], visible:false }, [9]);

    const animX = [];
    const animY = [];
    const animZ = [];
    const animAngles = [];      // angleDeg per point (for recomputing fade later)
    const animOpacities = [];   // current opacity per point (0.2–1.0)
    const animColorStrs = [];   // rgba() string per point, opacity baked in — this is what actually renders

    // 35 angle datasets: 10°, 20°, ..., 350° (aIdx from 1 to 35)
    for (let aIdx = 1; aIdx <= 35 && _animShouldRun; aIdx++) {
        const angleDeg = aIdx * 10;
        const theta    = angleDeg * Math.PI / 180;
        const ctx      = _buildAngleContext(theta);
        const xuList   = _xuList(ctx.extent);

        // Precompute all points for this angle
        const pathPts = [];

        for (let xIdx = 0; xIdx < xuList.length; xIdx++) {
            const xu = xuList[xIdx];
            try {
                const r = _computeOnePoint(theta, xu, ctx.extent, ctx.rotatedVertices, ctx.rotatedBars, ctx.minY);
                if (!isNaN(r.Pu) && !isNaN(r.Mx)) {
                    pathPts.push({ xu, r });
                }
            } catch(e) {}
        }

        if (pathPts.length === 0) continue;

        // Fade all previously plotted points down one more step now that a new
        // angle is starting (the new angle's own points aren't in animX yet, so
        // this only touches earlier angles). Opacity is re-baked into each
        // point's rgba() color string, since scatter3d ignores per-point
        // marker.opacity arrays.
        {
            const step = 0.8 / 34; // 0.0235294118
            for (let idx = 0; idx < animOpacities.length; idx++) {
                const datasetAngleIndex = Math.round(animAngles[idx] / 10); // 1 for 10°, 2 for 20°, ..., aIdx for current
                const k = aIdx - datasetAngleIndex; // steps behind newest dataset
                const opacity = Math.max(0.2, 1.0 - k * step);
                animOpacities[idx] = opacity;
                animColorStrs[idx] = _angleToRGBA(animAngles[idx], opacity);
            }
        }

        // Rotate the 3D viewport so the NA line always faces the viewer
        _setCameraForTheta(theta);

        for (let ptIdx = 0; ptIdx < pathPts.length && _animShouldRun; ptIdx++) {
            const { xu, r } = pathPts[ptIdx];
            const delay = speedEl ? parseInt(speedEl.value) : 20;

            // Live panel
            _updateLivePanel(theta, xu, r, angleDeg, 36, ptIdx, pathPts.length);

            // Update column model in-place
            const showP = document.getElementById('showProcess')?.checked ?? true;
            const col = getCenteredColumnTraces(theta, xu, scale, centerZ, colHeight);

            Plotly.restyle('plotlyPlot3D', {
                x: [col.concrete.x, col.rebars.x, col.naPlane.x, col.naLine.x, [r.Mx], col.compBlock.x],
                y: [col.concrete.y, col.rebars.y, col.naPlane.y, col.naLine.y, [r.My], col.compBlock.y],
                z: [col.concrete.z, col.rebars.z, col.naPlane.z, col.naLine.z, [r.Pu], col.compBlock.z],
                visible: [true, true, true, true, true, showP]
            }, [3, 4, 5, 6, 7, 8]);

            // Trace this point into the path (Trace 10) as the column reaches it —
            // the newest point always gets opacity 1.0, matching the column's current position.
            animX.push(r.Mx);
            animY.push(r.My);
            animZ.push(r.Pu);
            animAngles.push(angleDeg);
            animOpacities.push(1.0);
            animColorStrs.push(_angleToRGBA(angleDeg, 1.0));

            Plotly.restyle('plotlyPlot3D', {
                x: [animX],
                y: [animY],
                z: [animZ],
                'marker.color': [animColorStrs],
                customdata: [animAngles]
            }, [10]);

            if (delay > 0) await _sleep(delay);
        }
    }

    _animRunning = false;
    const btn = document.getElementById('btnPlayPause');
    if (btn) { btn.textContent = '▶ Play Again'; btn.disabled = false; }
    const st = document.getElementById('lv-status');
    if (st) st.textContent = '✓ Done';
}

function stopProcessAnimation() { _animShouldRun = false; }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Camera rotation ───────────────────────────────────────────────────────────
// Orbit the eye so the viewer always looks ALONG the NA line (edge-on view).
//
// Derivation:
//   NA normal in plot-XY at angle θ: n = (cosθ, sinθ)
//   Edge-on condition: camera_direction · n = 0
//   → cos(φ − θ) = 0  →  φ = θ + π/2
//
//   Camera moves CCW (+θ) while NA sweeps CW (−θ) → opposite → NA locked to user.
//
//   θ=0   → eye at (0, r, z)   — looks along −Y, NA plane normal is +X  ✓
//   θ=90° → eye at (−r, 0, z)  — looks along +X, NA plane normal is +Y  ✓
const _CAM_R = 1.98;   // ≈ √(1.4²+1.4²)
const _CAM_Z = 1.1;

function _setCameraForTheta(theta) {
    const angle = Math.PI / 2 + theta;   // CCW orbit — opposite to CW NA sweep
    Plotly.relayout('plotlyPlot3D', {
        'scene.camera': {
            eye:    { x: _CAM_R * Math.cos(angle), y: _CAM_R * Math.sin(angle), z: _CAM_Z },
            center: { x: 0, y: 0, z: 0 },
            up:     { x: 0, y: 0, z: 1 }
        }
    });
    
    // Highlight the selected angle on the failure surface by updating its colorscale/colors
    _highlightAngleOnMesh(theta);
}

// Dynamically fades the live trace points (Trace 10) so the angle under the
// camera stays brightest, keeping the main 3D surface plane (Trace 0) untouched.
function _highlightAngleOnMesh(targetTheta) {
    if (_animRunning) return; // Animation loop handles its own fading dynamically

    const targetDeg = Math.round((targetTheta * 180 / Math.PI) / 10) * 10;
    const targetAngleIdx = Math.round(targetDeg / 10);

    const livePlotData = document.getElementById('plotlyPlot3D').data[10];
    if (livePlotData && Array.isArray(livePlotData.customdata)) {
        const angles = livePlotData.customdata;
        const step = 0.8 / 34; // 0.0235294118
        const colors = angles.map((angleDeg) => {
            const datasetAngleIndex = Math.round(angleDeg / 10);
            const k = Math.abs(targetAngleIdx - datasetAngleIndex);
            const opacity = Math.max(0.2, 1.0 - k * step);
            return _angleToRGBA(angleDeg, opacity);
        });
        Plotly.restyle('plotlyPlot3D', {
            'marker.color': [colors]
        }, [10]);
    }
}

// ── Full render ───────────────────────────────────────────────────────────────
function render3DPlot(meshData) {
    const isDark    = !document.body.classList.contains('light-theme');
    const textColor = isDark ? '#f3f4f6' : '#0f172a';
    const gridColor = isDark ? '#2d3748' : '#e2e8f0';
    const paperBg   = isDark ? '#161b26' : '#ffffff';

    // Trace 0: failure surface — each angle (0°–350°) gets a unique hue via HSV colorscale
    const surfaceTrace = {
        type:'mesh3d', x:meshData.x, y:meshData.y, z:meshData.z,
        i:meshData.i, j:meshData.j, k:meshData.k,
        intensity: meshData.thetaDeg,   // color driven by bending angle, not Pu
        colorscale: _hsvColorscale(),
        cmin: 0, cmax: 350,
        showscale: false,
        opacity:0.78, name:'Failure Envelope',
        hovertemplate:'Mx: %{x:.1f} kNm<br>My: %{y:.1f} kNm<br>Pu: %{z:.1f} kN<extra></extra>'
    };

    const maxMu    = Math.max(...meshData.x.map(Math.abs), ...meshData.y.map(Math.abs)) || 100;
    const maxColDim = Math.max(maxX, maxY) / 2;
    const scale    = (0.28 * maxMu) / maxColDim;
    const minPu    = Math.min(...meshData.z);
    const maxPu    = Math.max(...meshData.z);
    const floorZ   = minPu - (maxPu - minPu) * 0.05;
    const centerZ  = (maxPu + minPu) / 2;
    const colHeight = (maxPu - minPu) * 0.35;

    _animScale = scale; _animCenterZ = centerZ; _animColHeight = colHeight; _animFloorZ = floorZ;

    const bHalf = maxX / 2, dHalf = maxY / 2;

    // Trace 1: floor outline (fixed, unrotated)
    let floorX=[], floorY=[], floorZ2=[];
    if (sectionType === 'circular') {
        const R = maxY / 2, Nc = 48;
        for (let n = 0; n <= Nc; n++) {
            const a = n * 2 * Math.PI / Nc;
            // toPlot convention: phys_y → plot X, phys_x → plot Y
            floorX.push(R * Math.sin(a) * scale);
            floorY.push(R * Math.cos(a) * scale);
            floorZ2.push(floorZ);
        }
    } else {
        // Rectangle outline (centred, fixed)
        // corners in physical: (±bHalf, ±dHalf); plot: x=phys_y*s, y=phys_x*s
        floorX = [-dHalf*scale, -dHalf*scale,  dHalf*scale,  dHalf*scale, -dHalf*scale];
        floorY = [-bHalf*scale,  bHalf*scale,  bHalf*scale, -bHalf*scale, -bHalf*scale];
        floorZ2 = [floorZ, floorZ, floorZ, floorZ, floorZ];
    }
    const floorOutlineTrace = {
        type:'scatter3d', mode:'lines',
        x:floorX, y:floorY, z:floorZ2,
        line:{ color:isDark?'rgba(255,255,255,0.3)':'rgba(0,0,0,0.3)', width:1.5 },
        hoverinfo:'skip', showlegend:false
    };

    // Trace 2: floor rebars (fixed)
    const xR=[], yR=[], zR=[], colR=[];
    circles.forEach(b => {
        xR.push((b.y - maxY/2) * scale);  // plot X = phys_y
        yR.push((b.x - maxX/2) * scale);  // plot Y = phys_x
        zR.push(floorZ);
        colR.push(b.color || '#60a5fa');
    });
    const floorRebarsTrace = {
        type:'scatter3d', mode:'markers',
        x:xR, y:yR, z:zR,
        marker:{ size:4, color:colR }, hoverinfo:'skip', showlegend:false
    };

    // Initial column at theta=0, Xu=D/2
    const initXu = maxY * 0.5;
    const col = getCenteredColumnTraces(0, initXu, scale, centerZ, colHeight);
    lastHoveredPtInfo = { theta:0, Xu:initXu, Mx:0, My:0, Pu:centerZ };

    const showProcess = document.getElementById('showProcess')?.checked ?? true;

    // Trace 3: concrete body
    const concreteTrace = {
        type:'mesh3d', x:col.concrete.x, y:col.concrete.y, z:col.concrete.z,
        i:col.concrete.i, j:col.concrete.j, k:col.concrete.k,
        color:isDark?'rgba(148,163,184,0.12)':'rgba(71,85,105,0.12)',
        flatshading:true, hoverinfo:'skip', name:'Column Section'
    };

    // Trace 4: rebars
    const rebarTrace = {
        type:'scatter3d', mode:'lines',
        x:col.rebars.x, y:col.rebars.y, z:col.rebars.z,
        line:{ color:'#60a5fa', width:4 }, hoverinfo:'skip', showlegend:false
    };

    // Trace 5: NA plane — replaced by a line; kept as empty placeholder to preserve trace indices
    const naPlaneTrace = {
        type:'mesh3d', x:[], y:[], z:[], i:[], j:[], k:[],
        visible:false, hoverinfo:'skip'
    };

    // Trace 6: NA line — single horizontal line at column mid-height
    const naLineTrace = {
        type:'scatter3d', mode:'lines',
        x:col.naLine.x, y:col.naLine.y, z:col.naLine.z,
        line:{ color:'#ef4444', width:5 },
        hoverinfo:'skip', showlegend:false, name:'Neutral Axis'
    };

    // Trace 7: active dot on surface
    const dotTrace = {
        type:'scatter3d', mode:'markers',
        x:[0], y:[0], z:[centerZ],
        marker:{ size:7, color:'#ef4444' }, hoverinfo:'skip', showlegend:false
    };

    // Trace 8: compression block
    const cbTrace = {
        type:'mesh3d', x:col.compBlock.x, y:col.compBlock.y, z:col.compBlock.z,
        i:col.compBlock.i, j:col.compBlock.j, k:col.compBlock.k,
        color:'rgba(59,130,246,0.32)', flatshading:true,
        hoverinfo:'skip', name:'Comp. Block', visible:showProcess
    };

    // Trace 9: current angle path line
    const centTrace = {
        type:'scatter3d', mode:'lines+markers', x:[], y:[], z:[],
        line:{ color:'rgba(234,179,8,0.4)', width:2.5 },
        marker:{ size:3.5, opacity:0.6 },
        hoverinfo:'skip', showlegend:false, visible:showProcess
    };

    // Trace 10: live growing scatter (animation)
    // Colors are rgba() strings with per-point opacity baked in (customdata holds
    // the raw angleDeg per point so hover-highlighting can recompute fades).
    const liveTrace = {
        type:'scatter3d', mode:'markers', x:[], y:[], z:[],
        customdata: [],
        marker:{
            size: 3.5,
            color: []   // filled with rgba(...) strings during animation
        },
        hoverinfo:'skip', showlegend:false, visible:false
    };

    // Calculate a constant axis limit to prevent dynamic resizing/pumping
    const maxColumnBendingLimit = Math.max(maxX, maxY) * scale;
    const axisLimit = Math.max(maxMu, maxColumnBendingLimit) * 1.15; // 15% padding for readability

    const layout = {
        paper_bgcolor: paperBg,
        margin: { t:0, r:0, l:0, b:0 },
        scene: {
            xaxis:{
                title:{ text:'Mx (kNm)', font:{color:textColor} },
                gridcolor:gridColor,
                tickfont:{color:textColor},
                range: [-axisLimit, axisLimit]
            },
            yaxis:{
                title:{ text:'My (kNm)', font:{color:textColor} },
                gridcolor:gridColor,
                tickfont:{color:textColor},
                range: [-axisLimit, axisLimit]
            },
            zaxis:{ title:{ text:'Pu (kN)',  font:{color:textColor} }, gridcolor:gridColor, tickfont:{color:textColor} },
            camera:{ eye:{ x: 0, y: _CAM_R, z: _CAM_Z } },  // θ=0 → edge-on NA view
            aspectmode: 'cube'
        },
        showlegend: false
    };

    const plotEl = document.getElementById('plotlyPlot3D');
    Plotly.newPlot(plotEl, [
        surfaceTrace,      // 0
        floorOutlineTrace, // 1
        floorRebarsTrace,  // 2
        concreteTrace,     // 3
        rebarTrace,        // 4
        naPlaneTrace,      // 5
        naLineTrace,       // 6
        dotTrace,          // 7
        cbTrace,           // 8
        centTrace,         // 9
        liveTrace          // 10
    ], layout, { responsive:true });

    // Lock camera to θ=0 edge-on view immediately — NA appears as a single line
    _setCameraForTheta(0);

    plotEl.on('plotly_hover', function(data) {
        if (_animRunning) return;
        if (data.points.length > 0) {
            const pt = calculatedPoints3D[data.points[0].pointIndex];
            if (pt) { lastHoveredPtInfo = pt; _restyleColumn(pt, scale, centerZ, colHeight); }
        }
    });

    return { scale, centerZ, colHeight };
}

// ── Restyle column on hover ───────────────────────────────────────────────────
function _restyleColumn(ptInfo, scale, centerZ, colHeight) {
    const showP = document.getElementById('showProcess')?.checked ?? true;
    const col   = getCenteredColumnTraces(ptInfo.theta, ptInfo.Xu, scale, centerZ, colHeight);
    Plotly.restyle('plotlyPlot3D', {
        x: [col.concrete.x, col.rebars.x, col.naPlane.x, col.naLine.x, [ptInfo.Mx], col.compBlock.x],
        y: [col.concrete.y, col.rebars.y, col.naPlane.y, col.naLine.y, [ptInfo.My], col.compBlock.y],
        z: [col.concrete.z, col.rebars.z, col.naPlane.z, col.naLine.z, [ptInfo.Pu], col.compBlock.z],
        visible: [true, true, true, true, true, showP]
    }, [3, 4, 5, 6, 7, 8]);
    // Rotate viewport to match this bending angle
    _setCameraForTheta(ptInfo.theta);
}

function updateProcessTraces() {
    if (calculatedPoints3D.length === 0) return;
    _restyleColumn(lastHoveredPtInfo, _animScale, _animCenterZ, _animColHeight);
}