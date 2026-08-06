// Shared mutable state for the section geometry, materials and calculated curves.
// Loaded first - every other module (materials.js, geometry.js, interaction-diagram.js,
// section-editor.js, plot-2d.js, plot-3d.js) reads/writes these top-level bindings.

// Profiles cache to save states between shape transitions
let profiles = {
    rectangular: {
        circles: [
            { dia: 16, x: 50, y: 50, color: "#3b82f6" },
            { dia: 16, x: 300, y: 50, color: "#3b82f6" },
            { dia: 16, x: 50, y: 225, color: "#3b82f6" },
            { dia: 16, x: 300, y: 225, color: "#3b82f6" },
            { dia: 16, x: 300, y: 400, color: "#3b82f6" },
            { dia: 16, x: 50, y: 400, color: "#3b82f6" }
        ],
        maxX: 350,
        maxY: 450,
        fck: "25",
        fy: "Fe415",
        cover: 40
    },
    circular: {
        circles: [
            { dia: 16, x: 225, y: 65, color: "#3b82f6" },
            { dia: 16, x: 225, y: 385, color: "#3b82f6" },
            { dia: 16, x: 65, y: 225, color: "#3b82f6" },
            { dia: 16, x: 385, y: 225, color: "#3b82f6" },
            { dia: 16, x: 112, y: 112, color: "#3b82f6" },
            { dia: 16, x: 338, y: 112, color: "#3b82f6" },
            { dia: 16, x: 112, y: 338, color: "#3b82f6" },
            { dia: 16, x: 338, y: 338, color: "#3b82f6" }
        ],
        maxX: 450,
        maxY: 450,
        fck: "25",
        fy: "Fe415",
        cover: 40
    }
};

let sectionType = "rectangular";
let circles = [...profiles.rectangular.circles];
let maxX = profiles.rectangular.maxX;
let maxY = profiles.rectangular.maxY;
let fck = 25;
let fy = "Fe415";
const Est = 2 * Math.pow(10, 5);
const dataPoints = 300;
let calculatedCurve = [];
let selectedBarIndex = null;
let isDragging = false;
let activeTab = 'designTab';
let snappedYGlobal = 0;

let curveX = [];
let curveY = [];
let designCheckPoint = null; // { Pu, Mu, safe } - user-entered point to verify against the curve
let diagramsStale = false; // true once geometry/reinforcement changes after a diagram has been generated
