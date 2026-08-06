const H = require("./test_harness.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// ---------------------------------------------------------------------
// 1) Pu,max cap (IS 456 Cl. 39.3) — the fix under test
// ---------------------------------------------------------------------
function puMax(fck, fyNum, Ag, Asc) {
  const Ac = Ag - Asc;
  return (0.4 * fck * Ac + 0.67 * fyNum * Asc) / 1000; // kN
}

// Rectangular section
{
  H.setSectionType("rectangular");
  H.setFck(25);
  H.setFy("Fe415");
  H.setMaxX(350);
  H.setMaxY(450);
  const circles = [
    { dia: 25, x: 50, y: 50 }, { dia: 25, x: 300, y: 50 },
    { dia: 25, x: 50, y: 225 }, { dia: 25, x: 300, y: 225 },
    { dia: 25, x: 50, y: 400 }, { dia: 25, x: 300, y: 400 },
  ];
  H.setCircles(circles);

  const Ag = 350 * 450;
  const Asc = circles.reduce((s, c) => s + (Math.PI / 4) * c.dia * c.dia, 0);
  const expectedCap = puMax(25, 415, Ag, Asc);

  // Very large Xu -> whole section + all bars near/above yield strain -> pure-compression-like case
  const nearPure = H.initSectionForXu(100000);
  check(
    "rectangular: CF at very large Xu is capped at Pu,max",
    approx(nearPure.CF, expectedCap, 0.5),
    `CF=${nearPure.CF.toFixed(2)} expectedCap=${expectedCap.toFixed(2)}`
  );

  // A small/moderate Xu (well within flexure range) should NOT be affected by the cap
  const smallXu = H.initSectionForXu(150);
  check(
    "rectangular: CF at small Xu stays below Pu,max (cap doesn't distort flexure range)",
    smallXu.CF < expectedCap,
    `CF=${smallXu.CF.toFixed(2)} cap=${expectedCap.toFixed(2)}`
  );

  // Sweep across the full curve: no point should ever exceed the cap (within numerical tolerance)
  const curve = H.calculateInteractionDiagramForSection(350, 450, circles);
  const maxCF = Math.max(...curve.map(p => p.CF));
  check(
    "rectangular: no point on generated curve exceeds Pu,max",
    maxCF <= expectedCap + 0.5,
    `maxCF=${maxCF.toFixed(2)} cap=${expectedCap.toFixed(2)}`
  );
}

// Circular section
{
  H.setSectionType("circular");
  H.setFck(30);
  H.setFy("Fe500");
  H.setMaxX(450);
  H.setMaxY(450);
  const circles = [];
  const R = 450 / 2, cover = 40, Rbar = R - cover, dia = 20;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const theta = (i * 2 * Math.PI) / n;
    circles.push({ dia, x: R + Rbar * Math.cos(theta), y: R + Rbar * Math.sin(theta) });
  }
  H.setCircles(circles);

  const Ag = (Math.PI / 4) * 450 * 450;
  const Asc = circles.reduce((s, c) => s + (Math.PI / 4) * c.dia * c.dia, 0);
  const expectedCap = puMax(30, 500, Ag, Asc);

  const nearPure = H.initSectionForXu(100000);
  check(
    "circular: CF at very large Xu is capped at Pu,max",
    approx(nearPure.CF, expectedCap, 0.5),
    `CF=${nearPure.CF.toFixed(2)} expectedCap=${expectedCap.toFixed(2)}`
  );

  const smallXu = H.initSectionForXu(150);
  check(
    "circular: CF at small Xu stays below Pu,max",
    smallXu.CF < expectedCap,
    `CF=${smallXu.CF.toFixed(2)} cap=${expectedCap.toFixed(2)}`
  );

  const curve = H.calculateInteractionDiagramForSection(450, 450, circles);
  const maxCF = Math.max(...curve.map(p => p.CF));
  check(
    "circular: no point on generated curve exceeds Pu,max",
    maxCF <= expectedCap + 0.5,
    `maxCF=${maxCF.toFixed(2)} cap=${expectedCap.toFixed(2)}`
  );

  // getFyValue parses grade strings correctly (used by the cap formula)
  check("getFyValue parses Fe500 -> 500", H.getFyValue() === 500);
}

// fy grade parsing across all supported grades
{
  H.setFy("Fe250"); check("getFyValue Fe250 -> 250", H.getFyValue() === 250);
  H.setFy("Fe415"); check("getFyValue Fe415 -> 415", H.getFyValue() === 415);
  H.setFy("Fe550"); check("getFyValue Fe550 -> 550", H.getFyValue() === 550);
}

// ---------------------------------------------------------------------
// 2) Regression checks on circular-section geometry/strain logic
//    (confirms the fix didn't disturb previously-verified behavior)
// ---------------------------------------------------------------------

// Chord width formula for a circle of diameter D=450 (R=225)
{
  H.setSectionType("circular");
  H.setMaxY(450);
  const R = 225;
  check("circular width at y=0 (top) is 0", approx(H.getSectionWidthAtDepth(0), 0, 1e-6));
  check("circular width at y=D (bottom) is 0", approx(H.getSectionWidthAtDepth(450), 0, 1e-6));
  check("circular width at y=R (mid-depth) is the full diameter", approx(H.getSectionWidthAtDepth(R), 450, 1e-6));
}

// Strain-profile continuity at Xu = D boundary (Annex E-2 pivot at 0.002 @ 3D/7)
{
  const D = 450;
  const edgeAtBoundary = H.linearStrainCompatibilityInColumn(D, D, 0); // Xu == D, edge fiber
  check("strain at compression edge when Xu=D equals 0.0035", approx(edgeAtBoundary, 0.0035, 1e-9));

  const XuBig = 900;
  const edgeBig = H.linearStrainCompatibilityInColumn(D, XuBig, 0);
  const edgeBigViaFormula = H.linearStrainCompatibilityInColumn(D, D + 1e-9, 0);
  check(
    "Xu>D branch is continuous with Xu<=D branch as Xu -> D",
    approx(edgeBigViaFormula, 0.0035, 1e-6)
  );

  const pivot = H.linearStrainCompatibilityInColumn(D, XuBig, (3 / 7) * D);
  check("pivot strain at 3D/7 from compression edge is always 0.002 for Xu>D", approx(pivot, 0.002, 1e-9));
}

// Concrete parabolic-rectangular stress block sanity
{
  check("stress at strain=0 is 0", approx(H.stressInConcreteAtStrain(0), 0));
  check("stress at strain=0.002 (parabola apex) is 0.45*fck", approx(H.stressInConcreteAtStrain(0.002), 0.45 * H.getState().fck, 1e-6));
  check("stress plateaus at 0.45*fck for strain in [0.002, 0.0035]", approx(H.stressInConcreteAtStrain(0.003), 0.45 * H.getState().fck, 1e-6));
  check("tension strain (negative) ignored -> 0 stress", H.stressInConcreteAtStrain(-0.001) === undefined || H.stressInConcreteAtStrain(-0.001) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
