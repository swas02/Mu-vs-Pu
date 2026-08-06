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

    const speedEl = document.getElementById('animSpeed');

    // Wipe live scatter (Trace 2) and path line (Trace 1)
    Plotly.restyle('plotlyPlot3D', { x:[[]], y:[[]], z:[[]], 'marker.color':[[]], customdata:[[]], visible:true }, [2]);
    Plotly.restyle('plotlyPlot3D', { x:[[]], y:[[]], z:[[]], visible:false }, [1]);

    const animX = [];
    const animY = [];
    const animZ = [];
    const animAngles = [];      // angleDeg per point (for recomputing fade later)
    const animOpacities = [];   // current opacity per point (0.2–1.0)
    const animColorStrs = [];   // rgba() string per point, opacity baked in

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

        {
            const step = 0.8 / 34; // 0.0235294118
            for (let idx = 0; idx < animOpacities.length; idx++) {
                const datasetAngleIndex = Math.round(animAngles[idx] / 10);
                const k = aIdx - datasetAngleIndex;
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

            // Live panel & 2D section plot update
            _updateLivePanel(theta, xu, r, angleDeg, 36, ptIdx, pathPts.length);
            _update2DPlot(theta, xu);

            // Update active dot on 3D surface plot
            Plotly.restyle('plotlyPlot3D', {
                x: [[r.Mx]], y: [[r.My]], z: [[r.Pu]]
            }, [3]);

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
            }, [2]);

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
    
    _highlightAngleOnMesh(theta);
}

function _highlightAngleOnMesh(targetTheta) {
    if (_animRunning) return;

    const targetDeg = Math.round((targetTheta * 180 / Math.PI) / 10) * 10;
    const targetAngleIdx = Math.round(targetDeg / 10);

    const livePlotData = document.getElementById('plotlyPlot3D').data[2];
    if (livePlotData && Array.isArray(livePlotData.customdata)) {
        const angles = livePlotData.customdata;
        const step = 0.8 / 34;
        const colors = angles.map((angleDeg) => {
            const datasetAngleIndex = Math.round(angleDeg / 10);
            const k = Math.abs(targetAngleIdx - datasetAngleIndex);
            const opacity = Math.max(0.2, 1.0 - k * step);
            return _angleToRGBA(angleDeg, opacity);
        });
        Plotly.restyle('plotlyPlot3D', {
            'marker.color': [colors]
        }, [2]);
    }
}

// ── 2D Column Cross-Section Plotting ──────────────────────────────────────────
function _update2DPlot(theta, Xu) {
    const plot2DEl = document.getElementById('plotlyPlot2D');
    if (!plot2DEl) return;

    const isDark = !document.body.classList.contains('light-theme');
    const textColor = isDark ? '#f3f4f6' : '#0f172a';
    const gridColor = isDark ? '#2d3748' : '#e2e8f0';

    const bHalf = maxX / 2;
    const dHalf = maxY / 2;

    // Helper to rotate point by +theta around origin so section matches horizontal NA (y = d)
    const rot = (px, py) => {
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        return {
            x: px * cos - py * sin,
            y: px * sin + py * cos
        };
    };

    // 1. Column Outline (X: mm, Y: mm centered at 0,0, rotated by -theta)
    let rawOutline = [];
    if (sectionType === 'circular') {
        const R = maxY / 2, Nc = 64;
        for (let n = 0; n <= Nc; n++) {
            const a = n * 2 * Math.PI / Nc;
            rawOutline.push({ px: R * Math.cos(a), py: R * Math.sin(a) });
        }
    } else {
        rawOutline = [
            { px: -bHalf, py: -dHalf }, { px: bHalf, py: -dHalf },
            { px: bHalf, py: dHalf }, { px: -bHalf, py: dHalf }, { px: -bHalf, py: -dHalf }
        ];
    }
    const rotOutline = rawOutline.map(p => rot(p.px, p.py));

    const outlineTrace = {
        type: 'scatter', mode: 'lines',
        x: rotOutline.map(p => p.x),
        y: rotOutline.map(p => p.y),
        fill: 'toself',
        fillcolor: isDark ? 'rgba(51, 65, 85, 0.4)' : 'rgba(226, 232, 240, 0.6)',
        line: { color: isDark ? '#94a3b8' : '#475569', width: 2 },
        name: 'Concrete Section', hoverinfo: 'skip'
    };

    // 2. Rebars (rotated by -theta)
    const rotBars = circles.map(c => rot(c.x - bHalf, c.y - dHalf));
    const rebarTrace = {
        type: 'scatter', mode: 'markers',
        x: rotBars.map(p => p.x),
        y: rotBars.map(p => p.y),
        marker: { size: 10, color: '#3b82f6', line: { color: '#1d4ed8', width: 1.5 } },
        name: 'Rebars', hoverinfo: 'skip'
    };

    // 3. Neutral Axis (NA) & Compression Zone
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    let extent;

    if (sectionType === 'circular') {
        extent = maxY;
    } else {
        extent = maxX * Math.abs(sinT) + maxY * Math.abs(cosT);
    }
    const d = extent / 2 - Xu; // distance of NA from centroid along compression normal (sinθ, cosθ)

    // In rotated frame (-theta):
    // Compression normal (sinθ, cosθ) rotates to (0, 1).
    // So the NA line in rotated frame is simply y = d (horizontal)!

    // Compression Zone Polygon
    let rawComp = [];
    if (sectionType === 'circular') {
        const R = maxY / 2, Nc2 = 64;
        for (let n = 0; n < Nc2; n++) {
            const alpha = n * 2 * Math.PI / Nc2;
            const px = R * Math.cos(alpha), py = R * Math.sin(alpha);
            if (px * sinT + py * cosT >= d - 1e-6) rawComp.push({ px, py });
        }
        if (Math.abs(d) <= R) {
            const halfL = Math.sqrt(R * R - d * d);
            rawComp.push({ px: d * sinT + halfL * (-cosT), py: d * cosT + halfL * sinT });
            rawComp.push({ px: d * sinT - halfL * (-cosT), py: d * cosT - halfL * sinT });
        }
    } else {
        const poly = [
            { px: -bHalf, py: -dHalf }, { px: bHalf, py: -dHalf },
            { px: bHalf, py: dHalf }, { px: -bHalf, py: dHalf }
        ];
        const N = poly.length;
        for (let i = 0; i < N; i++) {
            const cur = poly[i], nxt = poly[(i + 1) % N];
            const dc = cur.px * sinT + cur.py * cosT;
            const dn = nxt.px * sinT + nxt.py * cosT;
            if (dc >= d) rawComp.push(cur);
            if ((dc >= d) !== (dn >= d)) {
                const t = (d - dc) / (dn - dc);
                rawComp.push({ px: cur.px + t * (nxt.px - cur.px), py: cur.py + t * (nxt.py - cur.py) });
            }
        }
    }
    const rotComp = rawComp.map(p => rot(p.px, p.py));

    const compTrace = {
        type: 'scatter', mode: 'lines',
        x: rotComp.map(p => p.x),
        y: rotComp.map(p => p.y),
        fill: 'toself',
        fillcolor: 'rgba(239, 68, 68, 0.35)',
        line: { color: 'rgba(239, 68, 68, 0.8)', width: 1.5 },
        name: 'Compression Zone', hoverinfo: 'skip'
    };

    // Horizontal Neutral Axis line across plot span at y = d
    const maxDim = Math.max(maxX, maxY) * 0.75;
    const naTrace = {
        type: 'scatter', mode: 'lines',
        x: [-maxDim, maxDim],
        y: [d, d],
        line: { color: '#ef4444', width: 3, dash: 'dash' },
        name: 'Neutral Axis', hoverinfo: 'skip'
    };

    const layout2D = {
        margin: { t: 25, r: 25, l: 45, b: 40 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        xaxis: {
            title: { text: 'X (mm)', font: { color: textColor, size: 11 } },
            gridcolor: gridColor, tickfont: { color: textColor, size: 10 },
            range: [-maxDim, maxDim], scaleanchor: 'y', scaleratio: 1
        },
        yaxis: {
            title: { text: 'Y (mm)', font: { color: textColor, size: 11 } },
            gridcolor: gridColor, tickfont: { color: textColor, size: 10 },
            range: [-maxDim, maxDim]
        },
        showlegend: false
    };

    if (plot2DEl.data) {
        Plotly.react(plot2DEl, [outlineTrace, compTrace, rebarTrace, naTrace], layout2D, { responsive: true });
    } else {
        Plotly.newPlot(plot2DEl, [outlineTrace, compTrace, rebarTrace, naTrace], layout2D, { responsive: true });
    }
}

// ── Full render ───────────────────────────────────────────────────────────────
function render3DPlot(meshData) {
    const isDark    = !document.body.classList.contains('light-theme');
    const textColor = isDark ? '#f3f4f6' : '#0f172a';
    const gridColor = isDark ? '#2d3748' : '#e2e8f0';
    const paperBg   = isDark ? '#161b26' : '#ffffff';

    // Trace 0: failure surface
    const surfaceTrace = {
        type:'mesh3d', x:meshData.x, y:meshData.y, z:meshData.z,
        i:meshData.i, j:meshData.j, k:meshData.k,
        intensity: meshData.thetaDeg,
        colorscale: _hsvColorscale(),
        cmin: 0, cmax: 350,
        showscale: false,
        opacity:0.78, name:'Failure Envelope',
        hovertemplate:'Mx: %{x:.1f} kNm<br>My: %{y:.1f} kNm<br>Pu: %{z:.1f} kN<extra></extra>'
    };

    const maxMu    = Math.max(...meshData.x.map(Math.abs), ...meshData.y.map(Math.abs)) || 100;
    const minPu    = Math.min(...meshData.z);
    const maxPu    = Math.max(...meshData.z);
    const centerZ  = (maxPu + minPu) / 2;

    _animScale = 1; _animCenterZ = centerZ; _animColHeight = (maxPu - minPu) * 0.35;

    // Trace 1: current angle path line
    const centTrace = {
        type:'scatter3d', mode:'lines+markers', x:[], y:[], z:[],
        line:{ color:'rgba(234,179,8,0.4)', width:2.5 },
        marker:{ size:3.5, opacity:0.6 },
        hoverinfo:'skip', showlegend:false, visible:true
    };

    // Trace 2: live growing scatter (animation)
    const liveTrace = {
        type:'scatter3d', mode:'markers', x:[], y:[], z:[],
        customdata: [],
        marker:{
            size: 3.5,
            color: []
        },
        hoverinfo:'skip', showlegend:false, visible:false
    };

    // Trace 3: active dot on 3D surface
    const dotTrace = {
        type:'scatter3d', mode:'markers',
        x:[0], y:[0], z:[centerZ],
        marker:{ size:8, color:'#ef4444' }, hoverinfo:'skip', showlegend:false
    };

    const axisLimit = maxMu * 1.15;

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
            camera:{ eye:{ x: 0, y: _CAM_R, z: _CAM_Z } },
            aspectmode: 'cube'
        },
        showlegend: false
    };

    const plotEl = document.getElementById('plotlyPlot3D');
    Plotly.newPlot(plotEl, [
        surfaceTrace,      // 0
        centTrace,         // 1
        liveTrace,         // 2
        dotTrace           // 3
    ], layout, { responsive:true });

    // Initial 2D Column & Camera setup
    const initXu = maxY * 0.5;
    lastHoveredPtInfo = { theta:0, Xu:initXu, Mx:0, My:0, Pu:centerZ };
    _update2DPlot(0, initXu);
    _setCameraForTheta(0);

    plotEl.on('plotly_hover', function(data) {
        if (_animRunning) return;
        if (data.points.length > 0) {
            const pt = calculatedPoints3D[data.points[0].pointIndex];
            if (pt) {
                lastHoveredPtInfo = pt;
                _restyleColumn(pt);
            }
        }
    });

    return { scale: 1, centerZ, colHeight: (maxPu - minPu) * 0.35 };
}

// ── Restyle column on hover ───────────────────────────────────────────────────
function _restyleColumn(ptInfo) {
    // Update active dot position on 3D surface plot
    Plotly.restyle('plotlyPlot3D', {
        x: [[ptInfo.Mx]],
        y: [[ptInfo.My]],
        z: [[ptInfo.Pu]]
    }, [3]);

    // Update 2D cross-section graph
    _update2DPlot(ptInfo.theta, ptInfo.Xu);

    // Rotate viewport to match this bending angle
    _setCameraForTheta(ptInfo.theta);
}

function updateProcessTraces() {
    if (calculatedPoints3D.length === 0) return;
    _restyleColumn(lastHoveredPtInfo);
}