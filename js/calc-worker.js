// Web Worker for IS 456 Biaxial Column Strain Compatibility Integration Calculations
// Offloads heavy multi-angle 3D capacity calculations (1080 steps across 36 angles)
// from the main UI thread to ensure 60fps smooth rendering and zero UI stutter.

self.onmessage = function(e) {
    const data = e.data;
    if (!data) return;

    const sectionType = data.sectionType || "rectangular";
    const maxX = parseFloat(data.maxX || data.b) || 350;
    const maxY = parseFloat(data.maxY || data.d || (data.radius ? data.radius * 2 : 450)) || 450;
    const fck = parseFloat(data.fck) || 25;
    const fy = data.fy || "Fe415";
    const circles = Array.isArray(data.reinforcementLocations || data.circles) ? (data.reinforcementLocations || data.circles) : [];

    const steps = computeWorkerAnimationSteps(sectionType, maxX, maxY, fck, fy, circles);
    self.postMessage({ type: 'STEPS_COMPUTED', steps: steps });
};

function getFyValue(fyStr) {
    if (typeof fyStr === 'number') return fyStr;
    const match = String(fyStr).match(/\d+/);
    return match ? parseFloat(match[0]) : 415;
}

function concreteStressIS456(eps, fck) {
    if (eps <= 0) return 0;
    const fcd = 0.446 * fck;
    if (eps >= 0.0035) return fcd;
    if (eps >= 0.002) return fcd;
    const ratio = eps / 0.002;
    return fcd * (2 * ratio - ratio * ratio);
}

function getSteelStress(eps, fyStr) {
    const fyNum = getFyValue(fyStr);
    const Es = 2.0e5;
    const fyd = fyNum / 1.15;
    const absEps = Math.abs(eps);

    let stress = 0;
    if (fyNum === 250) {
        stress = Math.min(absEps * Es, fyd);
    } else {
        const epsY = fyd / Es;
        if (absEps <= epsY) {
            stress = absEps * Es;
        } else {
            const table = {
                0.80: 0.80 * fyd,
                0.85: 0.85 * fyd,
                0.90: 0.90 * fyd,
                0.95: 0.95 * fyd,
                0.975: 0.975 * fyd,
                1.00: 1.00 * fyd
            };
            const epsTotal = {
                0.80: (0.80 * fyd / Es),
                0.85: (0.85 * fyd / Es) + 0.0001,
                0.90: (0.90 * fyd / Es) + 0.0003,
                0.95: (0.95 * fyd / Es) + 0.0007,
                0.975: (0.975 * fyd / Es) + 0.0010,
                1.00: (1.00 * fyd / Es) + 0.0020
            };
            if (absEps >= epsTotal[1.00]) {
                stress = fyd;
            } else if (absEps >= epsTotal[0.975]) {
                const frac = (absEps - epsTotal[0.975]) / (epsTotal[1.00] - epsTotal[0.975]);
                stress = table[0.975] + frac * (table[1.00] - table[0.975]);
            } else if (absEps >= epsTotal[0.95]) {
                const frac = (absEps - epsTotal[0.95]) / (epsTotal[0.975] - epsTotal[0.95]);
                stress = table[0.95] + frac * (table[0.975] - table[0.95]);
            } else if (absEps >= epsTotal[0.90]) {
                const frac = (absEps - epsTotal[0.90]) / (epsTotal[0.95] - epsTotal[0.90]);
                stress = table[0.90] + frac * (table[0.95] - table[0.90]);
            } else if (absEps >= epsTotal[0.85]) {
                const frac = (absEps - epsTotal[0.85]) / (epsTotal[0.90] - epsTotal[0.85]);
                stress = table[0.85] + frac * (table[0.90] - table[0.85]);
            } else {
                const frac = (absEps - epsTotal[0.80]) / (epsTotal[0.85] - epsTotal[0.80]);
                stress = table[0.80] + frac * (table[0.85] - table[0.80]);
            }
        }
    }
    return eps >= 0 ? stress : -stress;
}

function getSectionWidthAtY(y, b, d, type) {
    if (y < 0 || y > d) return 0;
    if (type === "circular") {
        const R = d / 2;
        const dy = y - R;
        const rSq = R * R - dy * dy;
        return rSq > 0 ? 2 * Math.sqrt(rSq) : 0;
    }
    return b;
}

function linearStrainCompatibilityInColumn(y, Xu, d) {
    if (Xu <= d) {
        return 0.0035 * (1 - y / Xu);
    }
    return 0.002 * (1 - y / Xu) / (1 - (3 / 7) * d / Xu);
}

function initSectionForXu(Xu, b, d, circles, fck, fy, type) {
    const N = 100;
    const dy = d / N;
    let Cc = 0;
    let Mc = 0;
    const yCentroid = d / 2;

    for (let i = 0; i < N; i++) {
        const yMid = (i + 0.5) * dy;
        const width = getSectionWidthAtY(yMid, b, d, type);
        if (width <= 0) continue;
        const eps = linearStrainCompatibilityInColumn(yMid, Xu, d);
        if (eps > 0) {
            const sigmaC = concreteStressIS456(eps, fck);
            const forceCell = sigmaC * width * dy;
            Cc += forceCell;
            Mc += forceCell * (yCentroid - yMid);
        }
    }

    let CsTs = 0;
    let Ms = 0;

    for (let i = 0; i < circles.length; i++) {
        const bar = circles[i];
        const yBar = bar.y;
        const Ast = Math.PI * 0.25 * bar.dia * bar.dia;
        const epsS = linearStrainCompatibilityInColumn(yBar, Xu, d);
        const sigmaS = getSteelStress(epsS, fy);

        let sigmaC_atBar = 0;
        if (epsS > 0) {
            sigmaC_atBar = concreteStressIS456(epsS, fck);
        }

        const netSteelStress = sigmaS - sigmaC_atBar;
        const fBar = netSteelStress * Ast;

        CsTs += fBar;
        Ms += fBar * (yCentroid - yBar);
    }

    let rawCF = (Cc + CsTs) / 1000;
    let rawMOR = (Mc + Ms) / 1e6;

    let Ag = type === "circular" ? (Math.PI * d * d / 4) : (b * d);
    let Asc = 0;
    for (let i = 0; i < circles.length; i++) {
        Asc += Math.PI * 0.25 * circles[i].dia * circles[i].dia;
    }
    let fyVal = getFyValue(fy);
    let PuMax = (0.4 * fck * (Ag - Asc) + 0.67 * fyVal * Asc) / 1000;

    const CF = Math.min(rawCF, PuMax);
    const MOR = CF === PuMax ? Math.min(rawMOR, 0) : rawMOR;

    return { Xu, CF, MOR, PuMax };
}

function _xuListWorker(d) {
    const list = [];
    const minRatio = 0.05;
    const maxRatio = 1.60;
    const count = 30;

    for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const ratio = minRatio + t * (maxRatio - minRatio);
        list.push(parseFloat((ratio * d).toFixed(2)));
    }
    return list;
}

function calculateWorkerInteractionDiagram(bRot, dRot, rotatedBars, fck, fy, type) {
    const xus = _xuListWorker(dRot);
    const curve = [];

    for (let i = 0; i < xus.length; i++) {
        const Xu = xus[i];
        const pt = initSectionForXu(Xu, bRot, dRot, rotatedBars, fck, fy, type);
        curve.push(pt);
    }
    return curve;
}

function computeWorkerAnimationSteps(sectionType, maxX, maxY, fck, fy, circles) {
    const steps = [];
    const numAngles = 36;

    for (let aIdx = 0; aIdx < numAngles; aIdx++) {
        const thetaDeg = aIdx * 10;
        const thetaRad = (thetaDeg * Math.PI) / 180;

        let extent, rotatedBars;
        if (sectionType === "circular") {
            extent = { bRot: maxY, dRot: maxY };
            const cosT = Math.cos(-thetaRad);
            const sinT = Math.sin(-thetaRad);
            const cx = maxY / 2;
            const cy = maxY / 2;

            rotatedBars = circles.map(c => {
                const dx = c.x - cx;
                const dy = c.y - cy;
                const rx = dx * cosT - dy * sinT + cx;
                const ry = dx * sinT + dy * cosT + cy;
                return { ...c, x: rx, y: ry };
            });
        } else {
            const cx = maxX / 2;
            const cy = maxY / 2;

            const corners = [
                { x: 0, y: 0 },
                { x: maxX, y: 0 },
                { x: maxX, y: maxY },
                { x: 0, y: maxY }
            ];

            const cosT = Math.cos(-thetaRad);
            const sinT = Math.sin(-thetaRad);

            const rotCorners = corners.map(pt => {
                const dx = pt.x - cx;
                const dy = pt.y - cy;
                return {
                    x: dx * cosT - dy * sinT,
                    y: dx * sinT + dy * cosT
                };
            });

            const xs = rotCorners.map(p => p.x);
            const ys = rotCorners.map(p => p.y);

            const minX = Math.min(...xs), maxX_rot = Math.max(...xs);
            const minY = Math.min(...ys), maxY_rot = Math.max(...ys);

            const bRot = maxX_rot - minX;
            const dRot = maxY_rot - minY;

            extent = { bRot, dRot };

            rotatedBars = circles.map(c => {
                const dx = c.x - cx;
                const dy = c.y - cy;
                const rx = dx * cosT - dy * sinT - minX;
                const ry = dx * sinT + dy * cosT - minY;
                return { ...c, x: rx, y: ry };
            });
        }

        const curve = calculateWorkerInteractionDiagram(extent.bRot, extent.dRot, rotatedBars, fck, fy, sectionType);

        for (let i = 0; i < curve.length; i++) {
            const pt = curve[i];
            const Mu = Math.max(0, pt.MOR);
            const Mx = Mu * Math.cos(thetaRad);
            const My = Mu * Math.sin(thetaRad);
            const Pu = pt.CF;

            steps.push({
                stepIndex: steps.length + 1,
                thetaDeg,
                thetaRad,
                Xu: pt.Xu,
                Pu,
                Mu,
                Mx,
                My,
                extent
            });
        }
    }

    return steps;
}
