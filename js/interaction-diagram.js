// Xu-sweep force/moment integration and the P-M capacity curve builder.
// Depends on js/state.js, js/materials.js and js/geometry.js.

function calculateConcreteForceAndMoment(Xu) {
    const dComp = Math.min(Xu, maxY);
    if (dComp <= 0) return { CFc: 0, MORc: 0 };

    const N = 500;
    const h = dComp / N;

    let forceIntegral = 0;
    let momentIntegral = 0;

    for (let i = 0; i <= N; i++) {
        const y = i * h;
        const strain = linearStrainCompatibilityInColumn(maxY, Xu, y);
        const stress = stressInConcreteAtStrain(strain);
        const width = getSectionWidthAtDepth(y);
        const f = stress * width;
        const m = f * ((maxY / 2) - y);

        let coeff = 2;
        if (i === 0 || i === N) coeff = 1;
        else if (i % 2 === 1) coeff = 4;

        forceIntegral += coeff * f;
        momentIntegral += coeff * m;
    }

    return {
        CFc: (forceIntegral * h / 3) * Math.pow(10, -3), // to kN
        MORc: (momentIntegral * h / 3) * Math.pow(10, -6) // to kNm
    };
}

function initSectionForXu(Xu) {
    let data = [];
    let CFs = 0;
    let MORs = 0;

    circles.forEach((e) => {
        const strain = linearStrainCompatibilityInColumn(maxY, Xu, e.y);
        const ast = (Math.PI / 4) * Math.pow(e.dia, 2);
        const stressInConc = stressInConcreteAtStrain(strain);
        const stressInSteel = stressInSteelAtStrain(strain);
        const forceInConc = stressInConc * ast;
        const forceInSteel = stressInSteel * ast;
        const reducedForce = forceInSteel - forceInConc; // Subtract concrete displaced area force
        const leverArm = ((maxY / 2) - e.y);
        const MorOfSteel = forceInSteel * leverArm;
        const MorOfConc = forceInConc * leverArm;
        const reducedMOR = MorOfSteel - MorOfConc;

        CFs += reducedForce;
        MORs += reducedMOR;
        data.push({ Xu, x: e.x, y: e.y, strain, ast, stressInConc, forceInConc, stressInSteel, forceInSteel, reducedForce, MorOfSteel, MorOfConc, reducedMOR, leverArm });
    });

    const concrete = calculateConcreteForceAndMoment(Xu);

    let CF = concrete.CFc + CFs * Math.pow(10, -3); // to kN
    const MOR = concrete.MORc + MORs * Math.pow(10, -6); // to kNm

    // IS 456 Cl. 39.3: axial capacity of any column is capped at
    // Pu,max = 0.4*fck*Ac + 0.67*fy*Asc, regardless of Mu, to account
    // for the code-mandated minimum eccentricity.
    const Asc = circles.reduce((sum, e) => sum + (Math.PI / 4) * e.dia * e.dia, 0);
    const Ag = sectionType === "circular" ? (Math.PI / 4) * maxY * maxY : maxX * maxY;
    const Ac = Ag - Asc;
    const PuMax = (0.4 * fck * Ac + 0.67 * getFyValue() * Asc) * Math.pow(10, -3); // to kN
    if (CF > PuMax) CF = PuMax;

    return { Xu, CF, MOR, concrete, data };
}

// Perform interaction diagram calculation for a specific geometry
function calculateInteractionDiagramForSection(w, d, bars) {
    let curve = [];
    const divisions = dataPoints;

    // Temporary replacement of globals during calculation to keep codebase clean
    const originalMaxX = maxX;
    const originalMaxY = maxY;
    const originalCircles = circles;

    maxX = w;
    maxY = d;
    circles = bars;

    for (let i = divisions; i >= -divisions / 5; i--) {
        let XuVal;
        if (i > divisions * 0.8) {
            XuVal = maxY + (i - divisions * 0.8) * (9 * maxY) / (divisions * 0.2);
        } else if (i >= 0) {
            XuVal = 0.05 * maxY + i * (0.95 * maxY) / (divisions * 0.8);
        } else {
            XuVal = 0.01 * maxY + (i + divisions/5) * (0.04 * maxY) / (divisions/5);
        }

        const roundedXu = Math.round(XuVal * 10) / 10;
        try {
            const dataPoint = initSectionForXu(roundedXu);
            if (!isNaN(dataPoint.CF) && !isNaN(dataPoint.MOR)) {
                curve.push(dataPoint);
            }
        } catch(e) {
            // Skip invalid points
        }
    }

    // Restore globals
    maxX = originalMaxX;
    maxY = originalMaxY;
    circles = originalCircles;

    return curve;
}

// Find the moment capacity envelope at a given axial load Pu.
// The curve is walked in its native Xu order (NOT sorted by Pu) because Pu(Xu) is only
// approximately monotonic - numerical kinks (steel bilinear breakpoints, the Xu<=D / Xu>D
// strain-formula switch) can make the same Pu bracket more than one segment. Every bracketing
// segment is interpolated and the largest Mu among them is returned, since that outer boundary
// is the true capacity at that Pu - not just whichever segment happens to sort first.
function findCapacityAtPu(curve, Pu) {
    if (!curve || curve.length < 2) return null;

    let capacityMu = null;
    for (let i = 0; i < curve.length - 1; i++) {
        const a = curve[i], b = curve[i + 1];
        const lo = Math.min(a.CF, b.CF), hi = Math.max(a.CF, b.CF);
        if (Pu < lo || Pu > hi) continue;

        const interpMu = (a.CF === b.CF)
            ? Math.max(a.MOR, b.MOR)
            : a.MOR + (Pu - a.CF) / (b.CF - a.CF) * (b.MOR - a.MOR);

        if (capacityMu === null || interpMu > capacityMu) capacityMu = interpMu;
    }
    return capacityMu;
}
