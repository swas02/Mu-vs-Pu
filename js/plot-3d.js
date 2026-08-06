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
let _animPaused    = false;
let _animStartAIdx = 1;
let _animStartPtIdx = 0;
let _animX = [], _animY = [], _animZ = [];
let _animAngles = [], _animOpacities = [], _animColorStrs = [];
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

/**
 * Computes and returns complete mechanical and geometric data for a given (thetaDeg, Xu) state.
 * @param {number} thetaDeg - Bending angle in degrees (e.g. 350.0)
 * @param {number} Xu - Neutral Axis depth in mm (e.g. 5.0)
 * @returns {object} Detailed point info object containing thetaDeg, Xu, Pu, MOR/Mu, Mx, My, Cc, Cs, Ts, e_top, e_bot
 */
function getPointData(thetaDeg, Xu) {
    const theta = (thetaDeg % 360) * Math.PI / 180;
    const ctx = _buildAngleContext(theta);
    const result = _computeOnePoint(theta, Xu, ctx.extent, ctx.rotatedVertices, ctx.rotatedBars, ctx.minY);
    const xuList = _xuList(ctx.extent);
    const aIdx = Math.round((thetaDeg % 360) / 10);
    const ptIdx = Math.max(0, xuList.findIndex(x => Math.abs(x - Xu) < 1e-3));
    const totalSteps = 36 * xuList.length;
    const stepIndex = aIdx * xuList.length + ptIdx;

    return {
        thetaDeg: parseFloat(thetaDeg.toFixed(1)),
        thetaRad: theta,
        Xu: parseFloat(Xu.toFixed(1)),
        Pu: parseFloat(result.Pu.toFixed(1)),
        Mu: parseFloat(result.MOR.toFixed(2)),
        Mx: parseFloat(result.Mx.toFixed(2)),
        My: parseFloat(result.My.toFixed(2)),
        Cc: parseFloat(result.Cc.toFixed(1)),
        Cs: parseFloat(result.Cs_net.toFixed(1)),
        Ts: parseFloat(result.Ts_net.toFixed(1)),
        e_top: parseFloat((result.e_top * 1000).toFixed(2)),
        e_bot: parseFloat((result.e_bot * 1000).toFixed(2)),
        extent: ctx.extent,
        animationSteps: {
            stepIndex: stepIndex,
            angleIndex: aIdx,
            xuIndex: ptIdx,
            totalAngles: 36,
            totalXu: xuList.length,
            totalSteps: totalSteps,
            progressPct: parseFloat(((stepIndex + 1) / totalSteps * 100).toFixed(1))
        },
        raw: result
    };
}

let workerCachedAnimationSteps = null;
let calcWorkerInstance = null;

function triggerBackgroundWorkerCalc() {
    if (typeof window === 'undefined' || !window.Worker) return;
    try {
        if (calcWorkerInstance) {
            calcWorkerInstance.terminate();
        }
        calcWorkerInstance = new Worker('./js/calc-worker.js');
        calcWorkerInstance.onmessage = function(e) {
            if (e.data && e.data.type === 'STEPS_COMPUTED' && Array.isArray(e.data.steps)) {
                workerCachedAnimationSteps = e.data.steps;
            }
        };
        const sectionData = typeof getCurrentSectionData === 'function' ? getCurrentSectionData() : {
            sectionType, maxX, maxY, fck, fy, circles
        };
        calcWorkerInstance.postMessage(sectionData);
    } catch (err) {
        console.warn("Web Worker notice, falling back to main thread:", err);
    }
}

/**
 * Generates and returns the complete array of pre-computed animation step objects across all angles and Xu depths.
 * Utilizes Web Worker cached steps for 60fps smooth playback with main-thread fallback.
 * @returns {Array<object>} Array of all animation step objects
 */
function getAllAnimationSteps() {
    if (workerCachedAnimationSteps && workerCachedAnimationSteps.length > 0) {
        return workerCachedAnimationSteps;
    }

    const numAngles = 36;
    const steps = [];
    let globalStepIdx = 0;

    for (let aIdx = 0; aIdx < numAngles; aIdx++) {
        const angleDeg = aIdx * 10;
        const theta = angleDeg * Math.PI / 180;
        const ctx = _buildAngleContext(theta);
        const xuList = _xuList(ctx.extent);

        for (let ptIdx = 0; ptIdx < xuList.length; ptIdx++) {
            const xu = xuList[ptIdx];
            try {
                const data = getPointData(angleDeg, xu);
                data.animationSteps.stepIndex = globalStepIdx;
                data.animationSteps.progressPct = parseFloat(((globalStepIdx + 1) / (36 * xuList.length) * 100).toFixed(1));
                steps.push(data);
                globalStepIdx++;
            } catch(e) {}
        }
    }

    // Cache steps locally
    workerCachedAnimationSteps = steps;
    return steps;
}

let activeDemandPoint = null;

/**
 * Evaluates a design demand load point (Pu, Mux, Muy) against the 3D capacity surface.
 * Computes resultant moment Mu,D, capacity moment Mu,cap, and D/C capacity ratio.
 */
function checkDemandLoadPoint(puD, muxD, muyD) {
    const allSteps = getAllAnimationSteps();
    if (allSteps.length === 0) return null;

    const muD = Math.sqrt(muxD * muxD + muyD * muyD);
    let thetaRadD = Math.atan2(muyD, muxD);
    if (thetaRadD < 0) thetaRadD += 2 * Math.PI;
    const thetaDegD = thetaRadD * 180 / Math.PI;

    const angles = [];
    for (let a = 0; a < 36; a++) angles.push(a * 10);
    const closestAngle = angles.reduce((prev, curr) => Math.abs(curr - thetaDegD) < Math.abs(prev - thetaDegD) ? curr : prev);

    const angleSteps = allSteps.filter(s => Math.abs(s.thetaDeg - closestAngle) < 1.0);
    if (angleSteps.length === 0) return null;

    let closestStep = angleSteps[0];
    let minDiff = Math.abs(closestStep.Pu - puD);
    for (let i = 1; i < angleSteps.length; i++) {
        const diff = Math.abs(angleSteps[i].Pu - puD);
        if (diff < minDiff) {
            minDiff = diff;
            closestStep = angleSteps[i];
        }
    }

    const muCap = closestStep.Mu || 1;
    const dcRatio = muCap > 0 ? (muD / muCap) : 999;
    const isSafe = dcRatio <= 1.0;

    activeDemandPoint = {
        puD, muxD, muyD, muD, thetaDegD, closestAngle,
        muCap, dcRatio, isSafe
    };

    return activeDemandPoint;
}

let activeRangeStart = 1;
let activeRangeEnd = 1080;
let currentAnimStep = 1;

function setAnimationRange(minStep, maxStep) {
    const allSteps = getAllAnimationSteps();
    const total = (allSteps && allSteps.length) ? allSteps.length : 1080;
    activeRangeStart = Math.max(1, Math.min(total, minStep || 1));
    const targetEnd = (maxStep !== undefined && maxStep !== null) ? maxStep : total;
    activeRangeEnd = Math.max(activeRangeStart, Math.min(total, targetEnd));
}

/**
 * Plots 3D capacity points for a specific step or step range (1-indexed).
 * Examples:
 *   plot3DSteps(1)        -> plots step 1
 *   plot3DSteps(1, 40)    -> plots steps 1 to 40
 *   plot3DSteps(40, 60)   -> plots steps 40 to 60
 *
 * @param {number} startStep - Starting step number (1-indexed, e.g. 1 or 40)
 * @param {number} [endStep] - Ending step number (1-indexed, defaults to startStep)
 * @returns {object} Phase metadata and array of plotted step objects
 */
function plot3DSteps(startStep, endStep) {
    const allSteps = getAllAnimationSteps();
    if (allSteps.length === 0) return { error: "No animation steps available" };

    if (endStep === undefined || endStep === null) {
        endStep = startStep;
    }

    const sIdx = Math.max(0, Math.min(allSteps.length - 1, startStep - 1));
    const eIdx = Math.max(0, Math.min(allSteps.length - 1, endStep - 1));

    const minIdx = Math.min(sIdx, eIdx);
    const maxIdx = Math.max(sIdx, eIdx);

    const rangeSteps = allSteps.slice(minIdx, maxIdx + 1);
    const totalSteps = allSteps.length;
    const currentStep = maxIdx + 1;
    const progressPct = parseFloat(((currentStep / totalSteps) * 100).toFixed(1));

    const activeAngle = rangeSteps[rangeSteps.length - 1].thetaDeg;

    // If activeRangeStart === 1, we are sweeping from step 1 (Full Envelope mode).
    // If activeRangeStart > 1, we are inspecting a specific angle (Angle mode), so only plot rangeSteps for that angle!
    const isFullSweep = (activeRangeStart === 1);
    const accumulatedSteps = isFullSweep ? allSteps.slice(0, maxIdx + 1) : rangeSteps;
    const histSteps = isFullSweep ? accumulatedSteps.filter(s => Math.abs(s.thetaDeg - activeAngle) > 0.01) : [];
    const activeSteps = isFullSweep ? accumulatedSteps.filter(s => Math.abs(s.thetaDeg - activeAngle) <= 0.01) : rangeSteps;

    const phaseInfo = {
        startStep: minIdx + 1,
        endStep: maxIdx + 1,
        totalSteps: totalSteps,
        count: rangeSteps.length,
        progressPct: progressPct,
        startAngleDeg: rangeSteps[0].thetaDeg,
        endAngleDeg: activeAngle,
        phaseName: progressPct <= 25 ? "Initial Sweep (0°–90°)" :
                   progressPct <= 50 ? "Biaxial Quad 2 (90°–180°)" :
                   progressPct <= 75 ? "Biaxial Quad 3 (180°–270°)" : "Final Envelope Sweep (270°–360°)",
        steps: rangeSteps
    };

    const el3D = document.getElementById('plotlyPlot3D');
    if (el3D && typeof Plotly !== 'undefined') {
        const maxMu = Math.max(
            ...allSteps.map(s => Math.abs(s.Mx)),
            ...allSteps.map(s => Math.abs(s.My)),
            50
        );
        const axisLimit = Math.ceil(maxMu * 1.15);

        const allPu = allSteps.map(s => s.Pu);
        const minPu = Math.floor(Math.min(...allPu) * 1.1);
        const maxPu = Math.ceil(Math.max(...allPu) * 1.1);

        const isDark = typeof document !== 'undefined' && document.body.classList.contains('light-theme') ? false : true;
        const textColor = isDark ? '#f3f4f6' : '#0f172a';
        const gridColor = isDark ? '#2d3748' : '#e2e8f0';

        // Helper to format line arrays with null breaks between distinct bending angles
        const buildAngleLineArrays = (stepList) => {
            const x = [];
            const y = [];
            const z = [];
            const colors = [];
            const hovertext = [];

            let lastAngle = null;
            for (let i = 0; i < stepList.length; i++) {
                const s = stepList[i];
                const c = _angleToRGBA(s.thetaDeg, 1.0);
                if (lastAngle !== null && s.thetaDeg !== lastAngle) {
                    x.push(null);
                    y.push(null);
                    z.push(null);
                    colors.push(c);
                    hovertext.push('');
                }
                x.push(s.Mx);
                y.push(s.My);
                z.push(s.Pu);
                colors.push(c);

                const xud = (s.Xu / maxY).toFixed(3);
                const tip = `<b>Angle (θ):</b> ${s.thetaDeg.toFixed(1)}°<br>` +
                            `<b>Mx:</b> ${s.Mx.toFixed(1)} kNm<br>` +
                            `<b>My:</b> ${s.My.toFixed(1)} kNm<br>` +
                            `<b>Pu:</b> ${s.Pu.toFixed(1)} kN<br>` +
                            `<b>Xu:</b> ${s.Xu.toFixed(1)} mm<br>` +
                            `<b>Xu/d:</b> ${xud}`;
                hovertext.push(tip);

                lastAngle = s.thetaDeg;
            }
            return { x, y, z, colors, hovertext };
        };

        const histData = buildAngleLineArrays(histSteps);
        const activeData = buildAngleLineArrays(activeSteps);

        // Trace 0: Historical completed angle steps (opacity = 0.5)
        const histTrace = {
            type: 'scatter3d',
            mode: 'lines',
            x: histData.x,
            y: histData.y,
            z: histData.z,
            opacity: 0.5,
            line: {
                width: 3.5,
                color: histData.colors
            },
            hoverinfo: 'text',
            hovertext: histData.hovertext,
            name: 'Completed Angles (Faded)'
        };

        // Trace 1: Active current angle steps (opacity = 1.0)
        const activeTrace = {
            type: 'scatter3d',
            mode: 'lines',
            x: activeData.x,
            y: activeData.y,
            z: activeData.z,
            opacity: 1.0,
            line: {
                width: 5,
                color: activeData.colors
            },
            hoverinfo: 'text',
            hovertext: activeData.hovertext,
            name: `Active Angle (${activeAngle}°)`
        };

        const layout = {
            paper_bgcolor: 'transparent',
            margin: { t: 0, r: 0, l: 0, b: 0 },
            uirevision: 'same',
            scene: {
                xaxis: {
                    title: { text: 'Mx (kNm)', font: { color: textColor } },
                    gridcolor: gridColor, tickfont: { color: textColor },
                    range: [-axisLimit, axisLimit], autorange: false
                },
                yaxis: {
                    title: { text: 'My (kNm)', font: { color: textColor } },
                    gridcolor: gridColor, tickfont: { color: textColor },
                    range: [-axisLimit, axisLimit], autorange: false
                },
                zaxis: {
                    title: { text: 'Pu (kN)', font: { color: textColor } },
                    gridcolor: gridColor, tickfont: { color: textColor },
                    range: [minPu, maxPu], autorange: false
                },
                aspectmode: 'cube'
            },
            showlegend: false
        };

        // Optional Trace 2: Demand Load Point Marker (if active)
        const traces = [histTrace, activeTrace];
        if (activeDemandPoint) {
            traces.push({
                type: 'scatter3d',
                mode: 'markers+text',
                x: [activeDemandPoint.muxD],
                y: [activeDemandPoint.muyD],
                z: [activeDemandPoint.puD],
                marker: {
                    size: 8,
                    color: activeDemandPoint.isSafe ? '#10b981' : '#ef4444',
                    symbol: 'diamond',
                    line: { color: '#ffffff', width: 2 }
                },
                text: [activeDemandPoint.isSafe ? 'Demand Load (PASS)' : 'Demand Load (FAIL)'],
                textposition: 'top center',
                hoverinfo: 'text',
                hovertext: `<b>Demand Load Point</b><br>` +
                           `<b>Mx,D:</b> ${activeDemandPoint.muxD.toFixed(1)} kNm<br>` +
                           `<b>My,D:</b> ${activeDemandPoint.muyD.toFixed(1)} kNm<br>` +
                           `<b>Pu,D:</b> ${activeDemandPoint.puD.toFixed(1)} kN<br>` +
                           `<b>Resultant Mu,D:</b> ${activeDemandPoint.muD.toFixed(1)} kNm<br>` +
                           `<b>D/C Ratio:</b> ${activeDemandPoint.dcRatio.toFixed(2)} (${activeDemandPoint.isSafe ? 'PASS' : 'FAIL'})`,
                name: 'Demand Point'
            });
        }

        Plotly.react(el3D, traces, layout, { responsive: true });
    }

    const lastStep = rangeSteps[rangeSteps.length - 1];
    _update2DPlot(lastStep.thetaRad, lastStep.Xu, maxIdx + 1);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('hudTheta', `${lastStep.thetaDeg.toFixed(1)}°`);
    set('hudXu',    `${lastStep.Xu.toFixed(1)} mm`);
    set('hudXud',   `${(lastStep.Xu / maxY).toFixed(3)}`);
    set('hudPu',    `${lastStep.Pu.toFixed(1)} kN`);
    set('hudMu',    `${lastStep.Mu.toFixed(1)} kNm`);

    const angleSlider = document.getElementById('angleSpectrumSlider');
    const angleValLabel = document.getElementById('angleSpectrumVal');
    if (angleSlider) angleSlider.value = Math.round(lastStep.thetaDeg);
    if (angleValLabel) angleValLabel.textContent = `${lastStep.thetaDeg.toFixed(1)}°`;

    return phaseInfo;
}

/**
 * Renders the full 3D Capacity Mesh Surface with Heatmap / Contour color mapping based on Mu flexural capacity.
 */
function plot3DMeshSurface() {
    const allSteps = getAllAnimationSteps();
    if (allSteps.length === 0) return { error: "No animation steps available" };

    const numAngles = 36;
    const stepsPerAngle = Math.round(allSteps.length / numAngles) || 30;

    const xGrid = [];
    const yGrid = [];
    const zGrid = [];
    const colorGrid = [];
    const textGrid = [];

    for (let r = 0; r < stepsPerAngle; r++) {
        const xRow = [];
        const yRow = [];
        const zRow = [];
        const cRow = [];
        const tRow = [];

        for (let a = 0; a <= numAngles; a++) {
            const aIdx = a % numAngles;
            const stepIdx = aIdx * stepsPerAngle + r;
            const pt = allSteps[stepIdx] || allSteps[0];

            xRow.push(pt.Mx);
            yRow.push(pt.My);
            zRow.push(pt.Pu);
            cRow.push(pt.Mu); // Color mapped by Mu capacity

            const xud = (pt.Xu / maxY).toFixed(3);
            const tip = `<b>Angle (θ):</b> ${pt.thetaDeg.toFixed(1)}°<br>` +
                        `<b>Mx:</b> ${pt.Mx.toFixed(1)} kNm<br>` +
                        `<b>My:</b> ${pt.My.toFixed(1)} kNm<br>` +
                        `<b>Pu:</b> ${pt.Pu.toFixed(1)} kN<br>` +
                        `<b>Xu:</b> ${pt.Xu.toFixed(1)} mm<br>` +
                        `<b>Xu/d:</b> ${xud}`;
            tRow.push(tip);
        }
        xGrid.push(xRow);
        yGrid.push(yRow);
        zGrid.push(zRow);
        colorGrid.push(cRow);
        textGrid.push(tRow);
    }

    const el3D = document.getElementById('plotlyPlot3D');
    if (el3D && typeof Plotly !== 'undefined') {
        const maxMu = Math.max(...allSteps.map(s => Math.abs(s.Mx)), ...allSteps.map(s => Math.abs(s.My)), 50);
        const axisLimit = Math.ceil(maxMu * 1.15);
        const allPu = allSteps.map(s => s.Pu);
        const minPu = Math.floor(Math.min(...allPu) * 1.1);
        const maxPu = Math.ceil(Math.max(...allPu) * 1.1);

        const isDark = typeof document !== 'undefined' && document.body.classList.contains('light-theme') ? false : true;
        const textColor = isDark ? '#f3f4f6' : '#0f172a';
        const gridColor = isDark ? '#2d3748' : '#e2e8f0';

        const surfaceTrace = {
            type: 'surface',
            x: xGrid,
            y: yGrid,
            z: zGrid,
            surfacecolor: colorGrid,
            colorscale: 'Turbo', // Continuous heatmap / contour color gradient
            hoverinfo: 'text',
            hovertext: textGrid,
            colorbar: {
                title: { text: 'Mu (kNm)', font: { color: textColor, size: 11, family: 'Inter, sans-serif' } },
                tickfont: { color: textColor, size: 10 },
                len: 0.75,
                thickness: 14
            },
            contours: {
                x: { show: true, color: 'rgba(255,255,255,0.25)', width: 1, usecolormap: false },
                y: { show: true, color: 'rgba(255,255,255,0.25)', width: 1, usecolormap: false },
                z: { show: true, usecolormap: true, highlightcolor: '#ffffff', project: { z: true } }
            },
            lighting: {
                ambient: 0.7,
                diffuse: 0.85,
                specular: 0.35,
                roughness: 0.3,
                fresnel: 0.2
            },
            opacity: 0.95,
            name: 'Biaxial Mu-Pu Interaction Surface'
        };

        const layout = {
            paper_bgcolor: 'transparent',
            margin: { t: 0, r: 0, l: 0, b: 0 },
            uirevision: 'same',
            scene: {
                xaxis: { title: { text: 'Mx (kNm)', font: { color: textColor } }, gridcolor: gridColor, tickfont: { color: textColor }, range: [-axisLimit, axisLimit], autorange: false },
                yaxis: { title: { text: 'My (kNm)', font: { color: textColor } }, gridcolor: gridColor, tickfont: { color: textColor }, range: [-axisLimit, axisLimit], autorange: false },
                zaxis: { title: { text: 'Pu (kN)', font: { color: textColor } }, gridcolor: gridColor, tickfont: { color: textColor }, range: [minPu, maxPu], autorange: false },
                aspectmode: 'cube'
            },
            showlegend: false
        };

        const meshTraces = [surfaceTrace];
        if (activeDemandPoint) {
            meshTraces.push({
                type: 'scatter3d',
                mode: 'markers+text',
                x: [activeDemandPoint.muxD],
                y: [activeDemandPoint.muyD],
                z: [activeDemandPoint.puD],
                marker: {
                    size: 8,
                    color: activeDemandPoint.isSafe ? '#10b981' : '#ef4444',
                    symbol: 'diamond',
                    line: { color: '#ffffff', width: 2 }
                },
                text: [activeDemandPoint.isSafe ? 'Demand Load (PASS)' : 'Demand Load (FAIL)'],
                textposition: 'top center',
                hoverinfo: 'text',
                hovertext: `<b>Demand Load Point</b><br>` +
                           `<b>Mx,D:</b> ${activeDemandPoint.muxD.toFixed(1)} kNm<br>` +
                           `<b>My,D:</b> ${activeDemandPoint.muyD.toFixed(1)} kNm<br>` +
                           `<b>Pu,D:</b> ${activeDemandPoint.puD.toFixed(1)} kN<br>` +
                           `<b>Resultant Mu,D:</b> ${activeDemandPoint.muD.toFixed(1)} kNm<br>` +
                           `<b>D/C Ratio:</b> ${activeDemandPoint.dcRatio.toFixed(2)} (${activeDemandPoint.isSafe ? 'PASS' : 'FAIL'})`,
                name: 'Demand Point'
            });
        }

        Plotly.react(el3D, meshTraces, layout, { responsive: true });
    }
}

let animSpeedMultiplier = 3; // Default 3x Fast
let isAnimPlaying = false;
let animTimer = null;

function setAnimationSpeed(speedMultiplier) {
    animSpeedMultiplier = parseFloat(speedMultiplier) || 5;
}

function _getStepStride() {
    if (animSpeedMultiplier >= 10) return 15; // 10x Ultra: 1st, mid, and last (3 points per angle)
    if (animSpeedMultiplier >= 5)  return 6;  // 5x Fast: 5 key points per angle
    if (animSpeedMultiplier >= 2)  return 3;  // 2x Rapid: 10 key points per angle
    return 1;                                 // 1x / 0.5x: All 30 points per angle
}

function _syncAnimUI(info) {
    const playBtn = document.getElementById('animPlayPauseBtn');
    if (playBtn) {
        playBtn.innerHTML = isAnimPlaying
            ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Pause`
            : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play`;
    }

    const slider = document.getElementById('animStepSlider');
    if (slider) {
        slider.min = activeRangeStart;
        slider.max = activeRangeEnd;
        slider.value = currentAnimStep;
    }

    const badge = document.getElementById('animStepBadge');
    if (badge) {
        const total = (activeRangeEnd - activeRangeStart + 1);
        const progress = Math.round(((currentAnimStep - activeRangeStart + 1) / total) * 100);
        badge.textContent = `Step ${currentAnimStep} / ${activeRangeEnd} (${progress}%)`;
    }
}

/**
 * Incrementally appends a single step point to the active angle trace (Trace 1),
 * or transitions completed angles to historical background trace (Trace 0, opacity 0.3) when a new angle starts.
 * @param {number} stepNum - 1-indexed step number to append
 * @returns {object} Step info metadata
 */
function append3DStep(stepNum) {
    const allSteps = getAllAnimationSteps();
    if (allSteps.length === 0) return { error: "No animation steps available" };

    const idx = Math.max(0, Math.min(allSteps.length - 1, stepNum - 1));
    const stepData = allSteps[idx];
    const el3D = document.getElementById('plotlyPlot3D');

    if (el3D && typeof Plotly !== 'undefined') {
        plot3DSteps(activeRangeStart, stepNum);
    }

    _update2DPlot(stepData.thetaRad, stepData.Xu, idx + 1);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('hudTheta', `${stepData.thetaDeg.toFixed(1)}°`);
    set('hudXu',    `${stepData.Xu.toFixed(1)} mm`);
    set('hudXud',   `${(stepData.Xu / maxY).toFixed(3)}`);
    set('hudPu',    `${stepData.Pu.toFixed(1)} kN`);
    set('hudMu',    `${stepData.Mu.toFixed(1)} kNm`);

    const angleSlider = document.getElementById('angleSpectrumSlider');
    const angleValLabel = document.getElementById('angleSpectrumVal');
    if (angleSlider) angleSlider.value = Math.round(stepData.thetaDeg);
    if (angleValLabel) angleValLabel.textContent = `${stepData.thetaDeg.toFixed(1)}°`;

    const progressPct = parseFloat(((stepNum / allSteps.length) * 100).toFixed(1));
    return {
        currentStep: stepNum,
        totalSteps: allSteps.length,
        progressPct: progressPct,
        stepData: stepData
    };
}

/**
 * Generates subsampled intermediate step indices between the 1st and last step for each angle block,
 * based on the selected animation speed multiplier.
 * @param {number} totalSteps - Total number of animation steps
 * @param {number} speedMultiplier - Speed multiplier (e.g., 1x, 2x, 5x, 10x)
 * @returns {Array<number>} Array of step numbers (1-indexed) to render during animation playback
 */
function generateIntermediateAnimationSteps(totalSteps, speedMultiplier) {
    const allSteps = getAllAnimationSteps();
    if (!allSteps || allSteps.length === 0) return [];
    
    // For 1x or lower speed, return all step indices (1-indexed)
    if (speedMultiplier <= 1) {
        const fullSteps = [];
        for (let i = 1; i <= allSteps.length; i++) fullSteps.push(i);
        return fullSteps;
    }

    // Group steps by their exact angle thetaDeg
    const angleGroups = [];
    let currentGroup = [];
    let currentAngle = null;

    for (let i = 0; i < allSteps.length; i++) {
        const s = allSteps[i];
        const stepNum = i + 1; // 1-indexed
        if (currentAngle === null || Math.abs(s.thetaDeg - currentAngle) <= 0.01) {
            currentGroup.push(stepNum);
            currentAngle = s.thetaDeg;
        } else {
            if (currentGroup.length > 0) angleGroups.push(currentGroup);
            currentGroup = [stepNum];
            currentAngle = s.thetaDeg;
        }
    }
    if (currentGroup.length > 0) angleGroups.push(currentGroup);

    // Determine target intermediate step count per angle group based on speed (capped at 3x max)
    let pointsPerGroup;
    if (speedMultiplier >= 3) {
        pointsPerGroup = 6; // 3x Fast: 6 key intermediate points per angle block
    } else if (speedMultiplier >= 2) {
        pointsPerGroup = 12; // 2x Rapid: 12 key points per angle block
    } else {
        pointsPerGroup = 20;
    }

    const stepSequence = [];

    for (let g = 0; g < angleGroups.length; g++) {
        const group = angleGroups[g];
        if (group.length === 0) continue;

        if (pointsPerGroup <= 2 || group.length <= 2) {
            stepSequence.push(group[0]);
            if (group.length > 1) {
                stepSequence.push(group[group.length - 1]);
            }
        } else {
            const count = Math.min(pointsPerGroup, group.length);
            for (let i = 0; i < count; i++) {
                const idx = Math.round((i / (count - 1)) * (group.length - 1));
                const step = group[idx];
                if (stepSequence.length === 0 || stepSequence[stepSequence.length - 1] !== step) {
                    stepSequence.push(step);
                }
            }
        }
    }

    return stepSequence;
}

function _getNextAnimStep(currentStep) {
    const allSteps = getAllAnimationSteps();
    const totalSteps = allSteps.length || 1080;

    if (animSpeedMultiplier <= 1) {
        return Math.min(activeRangeEnd, currentStep + 1);
    }

    if (!cachedStepSequence || cachedSequenceSpeed !== animSpeedMultiplier) {
        cachedStepSequence = generateIntermediateAnimationSteps(totalSteps, animSpeedMultiplier);
        cachedSequenceSpeed = animSpeedMultiplier;
    }
    
    const sequence = cachedStepSequence;

    // Find next step in generated intermediate sequence that is strictly > currentStep
    for (let i = 0; i < sequence.length; i++) {
        if (sequence[i] > currentStep && sequence[i] <= activeRangeEnd) {
            return sequence[i];
        }
    }

    return Math.min(activeRangeEnd, currentStep + 1);
}

function playStepAnimation() {
    if (isAnimPlaying) return;
    const allSteps = getAllAnimationSteps();
    if (allSteps.length === 0) return;

    if (currentAnimStep >= activeRangeEnd || currentAnimStep < activeRangeStart) {
        currentAnimStep = activeRangeStart;
    }

    isAnimPlaying = true;

    const tick = () => {
        if (!isAnimPlaying) return;
        const info = plot3DSteps(activeRangeStart, currentAnimStep);
        _syncAnimUI(info);

        if (currentAnimStep >= activeRangeEnd) {
            pauseStepAnimation();
        } else {
            currentAnimStep = _getNextAnimStep(currentAnimStep);
            const delay = animSpeedMultiplier < 1 ? 80 : 16;
            animTimer = setTimeout(tick, delay);
        }
    };

    tick();
}

function pauseStepAnimation() {
    isAnimPlaying = false;
    if (animTimer) {
        clearTimeout(animTimer);
        animTimer = null;
    }
    _syncAnimUI();
}

function togglePlayPauseAnimation() {
    if (isAnimPlaying) {
        pauseStepAnimation();
    } else {
        playStepAnimation();
    }
}

function resetStepAnimation() {
    pauseStepAnimation();
    currentAnimStep = activeRangeStart;
    const info = plot3DSteps(activeRangeStart, currentAnimStep);
    _syncAnimUI(info);
}

function stepForwardAnimation() {
    pauseStepAnimation();
    if (currentAnimStep < activeRangeEnd) {
        currentAnimStep++;
    }
    const info = plot3DSteps(activeRangeStart, currentAnimStep);
    _syncAnimUI(info);
}

function stepBackwardAnimation() {
    pauseStepAnimation();
    if (currentAnimStep > activeRangeStart) {
        currentAnimStep--;
    }
    const info = plot3DSteps(activeRangeStart, currentAnimStep);
    _syncAnimUI(info);
}

function jumpToStep(stepNum) {
    pauseStepAnimation();
    const allSteps = getAllAnimationSteps();
    currentAnimStep = Math.max(activeRangeStart, Math.min(activeRangeEnd, parseInt(stepNum) || activeRangeStart));
    const info = plot3DSteps(activeRangeStart, currentAnimStep);
    _syncAnimUI(info);
}

let cachedStepSequence = null;
let cachedSequenceSpeed = null;

function setAnimationSpeed(speedMultiplier) {
    const mult = Math.min(3, Math.max(0.5, parseFloat(speedMultiplier) || 3));
    animSpeedMultiplier = mult;
    animSpeedMs = Math.max(5, Math.round(40 / mult));
    cachedStepSequence = null; // Clear cached sequence on speed change
}

// ── 2D Column Cross-Section Plotting ──────────────────────────────────────────
function _update2DPlot(theta, Xu, stepNum) {
    const plot2DEl = document.getElementById('plotlyPlot2D');
    if (!plot2DEl || typeof Plotly === 'undefined') return;

    const isDark = !document.body.classList.contains('light-theme');
    const textColor = isDark ? '#f3f4f6' : '#0f172a';
    const gridColor = isDark ? '#2d3748' : '#e2e8f0';

    const bHalf = maxX / 2;
    const dHalf = maxY / 2;

    // Helper to rotate point by +theta and apply side mirror (x -> -x)
    const rawRot = (px, py) => {
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        return {
            x: -(px * cos - py * sin),
            y: px * sin + py * cos
        };
    };

    // 1. Unrotated Outline (centred at 0,0)
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
    const tempRotOutline = rawOutline.map(p => rawRot(p.px, p.py));

    // Find minimum bounds to shift origin to (0, 0)
    const minX = Math.min(...tempRotOutline.map(p => p.x));
    const minY = Math.min(...tempRotOutline.map(p => p.y));

    // Shift function ensuring min X = 0 and min Y = 0
    const rot = (px, py) => {
        const r = rawRot(px, py);
        return {
            x: r.x - minX,
            y: r.y - minY
        };
    };

    const rotOutline = rawOutline.map(p => rot(p.px, p.py));
    const dimX = Math.max(...rotOutline.map(p => p.x));
    const dimY = Math.max(...rotOutline.map(p => p.y));

    const outlineTrace = {
        type: 'scatter', mode: 'lines',
        x: rotOutline.map(p => p.x),
        y: rotOutline.map(p => p.y),
        fill: 'toself',
        fillcolor: isDark ? 'rgba(51, 65, 85, 0.4)' : 'rgba(226, 232, 240, 0.6)',
        line: { color: isDark ? '#94a3b8' : '#475569', width: 2 },
        name: 'Concrete Section', hoverinfo: 'skip'
    };

    // 2. Rebars (shifted to >= 0)
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
    const d = extent / 2 - Xu;

    // Helper: Clip column polygon against horizontal NA line y = cutoffY
    const clipPolyAboveY = (poly, cutoffY) => {
        const out = [];
        const N = poly.length;
        for (let i = 0; i < N; i++) {
            const curr = poly[i];
            const next = poly[(i + 1) % N];
            const currIn = curr.y <= cutoffY;
            const nextIn = next.y <= cutoffY;

            if (currIn) out.push(curr);
            if (currIn !== nextIn) {
                const dy = next.y - curr.y;
                const t = Math.abs(dy) > 1e-9 ? (cutoffY - curr.y) / dy : 0;
                out.push({ x: curr.x + t * (next.x - curr.x), y: cutoffY });
            }
        }
        return out;
    };

    const clipPolyBelowY = (poly, cutoffY) => {
        const out = [];
        const N = poly.length;
        for (let i = 0; i < N; i++) {
            const curr = poly[i];
            const next = poly[(i + 1) % N];
            const currIn = curr.y >= cutoffY;
            const nextIn = next.y >= cutoffY;

            if (currIn) out.push(curr);
            if (currIn !== nextIn) {
                const dy = next.y - curr.y;
                const t = Math.abs(dy) > 1e-9 ? (cutoffY - curr.y) / dy : 0;
                out.push({ x: curr.x + t * (next.x - curr.x), y: cutoffY });
            }
        }
        return out;
    };

    // Compression zone polygon (y <= Xu inside column)
    const rotComp = clipPolyAboveY(rotOutline, Xu);

    const compTrace = {
        type: 'scatter', mode: 'lines',
        x: rotComp.map(p => p.x),
        y: rotComp.map(p => p.y),
        fill: 'toself',
        fillcolor: 'rgba(239, 68, 68, 0.35)',
        line: { color: 'rgba(239, 68, 68, 0.8)', width: 1.5 },
        name: 'Compression Zone', hoverinfo: 'skip'
    };

    // Tension zone polygon (y > Xu inside column)
    const rotTens = clipPolyBelowY(rotOutline, Xu);

    const tensTrace = {
        type: 'scatter', mode: 'lines',
        x: rotTens.map(p => p.x),
        y: rotTens.map(p => p.y),
        fill: 'toself',
        fillcolor: 'rgba(16, 185, 129, 0.25)',
        line: { color: 'rgba(16, 185, 129, 0.7)', width: 1.5 },
        name: 'Tension Zone', hoverinfo: 'skip'
    };

    // Neutral Axis line plotted directly as y = Xu (NA depth location)
    const naY = Xu;
    const maxSectionDim = sectionType === 'circular' ? maxY : Math.max(maxX, maxY);
    const maxSpan = 2 * maxSectionDim;

    const naTrace = {
        type: 'scatter', mode: 'lines',
        x: [0, maxSpan],
        y: [naY, naY],
        line: { color: '#ef4444', width: 3, dash: 'dash' },
        name: 'Neutral Axis', hoverinfo: 'skip'
    };

    const layout2D = {
        margin: { t: 25, r: 25, l: 45, b: 40 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        transition: {
            duration: Math.max(20, (typeof animSpeedMs !== 'undefined' ? animSpeedMs : 40) - 5),
            easing: 'cubic-in-out'
        },
        xaxis: {
            title: { text: 'X (mm)', font: { color: textColor, size: 11 } },
            gridcolor: gridColor, tickfont: { color: textColor, size: 10 },
            range: [0, maxSpan], scaleanchor: 'y', scaleratio: 1,
            autorange: false
        },
        yaxis: {
            title: { text: 'Y (mm)', font: { color: textColor, size: 11 } },
            gridcolor: gridColor, tickfont: { color: textColor, size: 10 },
            range: [0, maxSpan],
            autorange: false
        },
        showlegend: false
    };

    Plotly.react(plot2DEl, [outlineTrace, compTrace, tensTrace, rebarTrace, naTrace], layout2D, { responsive: true });

    const tag = document.getElementById('naDepthTag');
    if (tag) tag.innerHTML = `X<sub>u</sub> = ${Xu.toFixed(1)} mm ${stepNum ? `(Step ${stepNum})` : ''}`;
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

    set('hudTheta', `${angleDeg.toFixed(1)}°`);
    set('hudXu',    `${Xu.toFixed(1)} mm`);
    set('hudPu',    `${result.Pu.toFixed(1)} kN`);
    set('hudMu',    `${result.MOR.toFixed(1)} kNm`);

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
    return { x:xPoints, y:yPoints, z:zPoints, i:iIdx, j:jIdx, k:kIdx, thetaDeg };
}

/**
 * Generates the complete JSON data structure for the current section and all 3D capacity points.
 * @returns {object} JSON data object containing section properties and array of animation step objects
 */
function getFullSectionJSON() {
    const Asc = circles.reduce((s, e) => s + Math.PI / 4 * e.dia * e.dia, 0);
    const Ag = sectionType === 'circular' ? Math.PI / 4 * maxY * maxY : maxX * maxY;

    return {
        section: {
            shape: sectionType,
            width: maxX,
            depth: maxY,
            fck: fck,
            fy: fy,
            Asc: Math.round(Asc),
            pt: parseFloat((Asc / Ag * 100).toFixed(2)),
            circles: circles
        },
        animationSteps: getAllAnimationSteps()
    };
}