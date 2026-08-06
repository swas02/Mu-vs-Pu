// Standalone Node test harness for the interaction-diagram math in index.html.
// Extracts and concatenates the split JS files and exposes their internal functions/vars
// via closures, without needing a browser/DOM.
const fs = require("fs");
const path = require("path");

const stateSrc = fs.readFileSync(path.join(__dirname, "..", "js", "state.js"), "utf8");
const materialsSrc = fs.readFileSync(path.join(__dirname, "..", "js", "materials.js"), "utf8");
const geometrySrc = fs.readFileSync(path.join(__dirname, "..", "js", "geometry.js"), "utf8");
const diagramSrc = fs.readFileSync(path.join(__dirname, "..", "js", "interaction-diagram.js"), "utf8");

const src = [stateSrc, materialsSrc, geometrySrc, diagramSrc].join("\n");

function stubElement() {
  const el = {
    value: "",
    style: {},
    textContent: "",
    checked: false,
    classList: { contains: () => false, add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; },
    querySelector() { return stubElement(); },
    querySelectorAll() { return []; },
  };
  return el;
}

const document = {
  getElementById() { return stubElement(); },
  createElement() { return stubElement(); },
  createElementNS() { return stubElement(); },
  addEventListener() {},
  body: stubElement(),
};

const window = { addEventListener() {}, removeEventListener() {} };
const Plotly = { newPlot() {}, purge() {}, react() {} };
const navigator = {};
const alert = () => {};
const URL = { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} };
const Blob = function () {};

const factory = new Function(
  "document", "window", "Plotly", "navigator", "alert", "URL", "Blob",
  src + `
  return {
    getState: () => ({ fck, fy, maxX, maxY, circles, sectionType }),
    setFck: (v) => { fck = v; },
    setFy: (v) => { fy = v; },
    setMaxX: (v) => { maxX = v; },
    setMaxY: (v) => { maxY = v; },
    setCircles: (v) => { circles = v; },
    setSectionType: (v) => { sectionType = v; },
    initSectionForXu,
    calculateConcreteForceAndMoment,
    calculateInteractionDiagramForSection,
    getFyValue,
    linearStrainCompatibilityInColumn,
    stressInConcreteAtStrain,
    stressInSteelAtStrain,
    getSectionWidthAtDepth,
  };
  `
);

module.exports = factory(document, window, Plotly, navigator, alert, URL, Blob);
