// Plotly 2D P-M capacity curve rendering and design point checks.
// Depends on js/state.js, js/materials.js, and js/interaction-diagram.js.

// Reset the interaction diagram, profile plots, data table and design check to an empty state.
function purgeDiagramState() {
    curveX = [];
    curveY = [];
    calculatedCurve = [];
    diagramsStale = false;

    Plotly.purge("plotlyPlot");
    Plotly.purge("strainProfilePlot");
    Plotly.purge("stressProfilePlot");

    document.getElementById("profileXu").textContent = "- mm";
    document.getElementById("profilePu").textContent = "- kN";
    document.getElementById("profileMu").textContent = "- kNm";

    document.getElementById("dataPointsTableBody").innerHTML = "";

    designCheckPoint = null;
    const resultEl = document.getElementById("checkResult");
    if (resultEl) {
        resultEl.className = "check-result-badge";
        resultEl.textContent = "Enter Pu & Mu to verify";
    }
}

// Reflect current diagram state (empty / stale / fresh) in the status banners and Generate buttons.
function updateDiagramStatusUI() {
    const hasCurve = calculatedCurve.length > 0;
    const state = !hasCurve ? 'empty' : (diagramsStale ? 'stale' : 'fresh');

    document.querySelectorAll('.diagram-status-banner').forEach(el => {
        el.classList.remove('empty', 'stale', 'fresh');
        el.classList.add(state);
        el.textContent = state === 'empty'
            ? (circles.length === 0
                ? 'Add reinforcement, then click Generate Diagram to compute the Mu-Pu interaction curve.'
                : 'Click Generate Diagram to compute the Mu-Pu interaction curve.')
            : state === 'stale'
                ? 'Inputs changed since the last calculation — click Refresh Diagram to update it.'
                : '';
    });

    document.querySelectorAll('.generate-diagram-btn').forEach(btn => {
        btn.textContent = state === 'stale' ? 'Refresh Diagram' : 'Generate Diagram';
    });

    const axisGroupEl = document.getElementById("checkAxisGroup");
    if (axisGroupEl) axisGroupEl.style.display = sectionType === "circular" ? "none" : "";

    const tableAxisEl = document.getElementById("tableAxis");
    if (tableAxisEl) tableAxisEl.style.display = sectionType === "circular" ? "none" : "";
}

// Calculate the 2D capacity curves for bending about X and Y axes.
function computeCurves() {
    // Run 1: Bending about X-axis (D in compression)
    curveX = calculateInteractionDiagramForSection(maxX, maxY, circles);
    calculatedCurve = curveX; // Table data follows major axis (X-axis)

    // Run 2: Bending about Y-axis (b in compression)
    if (sectionType === "rectangular") {
        const swappedBars = circles.map(c => ({ ...c, x: c.y, y: c.x }));
        curveY = calculateInteractionDiagramForSection(maxY, maxX, swappedBars);
    } else {
        curveY = [];
    }

    diagramsStale = false;
}

// Draw the Plotly 2D chart, profile plots and data table from curve data.
function renderDiagramPlot() {
    const MuX = curveX.map(pt => pt.MOR);
    const PuX = curveX.map(pt => pt.CF);

    const isDark = !document.body.classList.contains('light-theme');
    const textColor = isDark ? '#f3f4f6' : '#0f172a';
    const gridColor = isDark ? '#2d3748' : '#e2e8f0';
    const paperBg = isDark ? '#161b26' : '#ffffff';

    const plotData = [{
        x: MuX,
        y: PuX,
        mode: 'lines+markers',
        type: 'scatter',
        name: sectionType === "circular" ? 'Capacity Envelope' : 'Bending about X-axis (D / maxY)',
        marker: { size: 3, color: '#3b82f6' },
        line: { shape: 'spline', color: '#3b82f6', width: 2.5 },
        hovertemplate: 'Mu: %{x:.1f} kNm<br>Pu: %{y:.1f} kN<extra></extra>'
    }];

    if (sectionType === "rectangular" && curveY.length > 0) {
        const MuY = curveY.map(pt => pt.MOR);
        const PuY = curveY.map(pt => pt.CF);
        plotData.push({
            x: MuY,
            y: PuY,
            mode: 'lines+markers',
            type: 'scatter',
            name: 'Bending about Y-axis (b / maxX)',
            marker: { size: 3, color: '#10b981' },
            line: { shape: 'spline', color: '#10b981', width: 2.5 },
            hovertemplate: 'Mu: %{x:.1f} kNm<br>Pu: %{y:.1f} kN<extra></extra>'
        });
    }

    if (designCheckPoint) {
        const status = evaluateDesignCheckPoint();
        const markerColor = status.safe ? '#10b981' : '#ef4444';
        plotData.push({
            x: [designCheckPoint.Mu],
            y: [designCheckPoint.Pu],
            mode: 'markers',
            type: 'scatter',
            name: 'Design Point',
            marker: { size: 18, color: markerColor, symbol: 'star', line: { width: 1.5, color: textColor } },
            hovertemplate: `Design Point<br>Mu: ${designCheckPoint.Mu} kNm<br>Pu: ${designCheckPoint.Pu} kN<extra></extra>`
        });
    }

    const layout = {
        paper_bgcolor: paperBg,
        plot_bgcolor: paperBg,
        xaxis: {
            title: { text: "Moment Mu (kNm)", font: { color: textColor, family: 'Plus Jakarta Sans' } },
            gridcolor: gridColor,
            tickfont: { color: textColor }
        },
        yaxis: {
            title: { text: "Axial Force Pu (kN)", font: { color: textColor, family: 'Plus Jakarta Sans' } },
            gridcolor: gridColor,
            tickfont: { color: textColor }
        },
        margin: { t: 40, r: 20, l: 65, b: 50 },
        hovermode: 'closest',
        legend: {
            font: { color: textColor },
            orientation: 'h',
            x: 0.5,
            xanchor: 'center',
            y: 1.12,
            yanchor: 'bottom'
        }
    };

    const plotEl = document.getElementById("plotlyPlot");
    Plotly.newPlot(plotEl, plotData, layout, { responsive: true });

    // Set up hover interactivity: plot concrete stress/strain on hover depending on curve
    plotEl.on('plotly_hover', function(data) {
        if (data.points.length > 0) {
            const curveNum = data.points[0].curveNumber;
            const pointIndex = data.points[0].pointIndex;
            
            if (curveNum === 0 && curveX[pointIndex]) {
                renderStrainAndStressProfiles(curveX[pointIndex], maxY);
            } else if (curveNum === 1 && curveY[pointIndex]) {
                renderStrainAndStressProfiles(curveY[pointIndex], maxX);
            }
        }
    });

    // Load initial profiles matching the balanced point or peak moment point of major axis
    if (calculatedCurve.length > 0) {
        let peakIndex = 0;
        let maxMu = 0;
        calculatedCurve.forEach((pt, idx) => {
            if (pt.MOR > maxMu) {
                maxMu = pt.MOR;
                peakIndex = idx;
            }
        });
        renderStrainAndStressProfiles(calculatedCurve[peakIndex], maxY);
    }

    // Update main details table
    updateDataTable();
}

// Manual trigger to calculate and render the diagram
function generateDiagram() {
    if (circles.length === 0) {
        purgeDiagramState();
        updateDiagramStatusUI();
        return;
    }

    computeCurves();
    renderDiagramPlot();
    updateDiagramStatusUI();
}

// Evaluate the design point
function evaluateDesignCheckPoint() {
    const resultEl = document.getElementById("checkResult");
    const { Pu, Mu, axis } = designCheckPoint;
    const curve = (sectionType === "circular" || axis === "x") ? curveX : curveY;

    if (!curve || curve.length === 0) {
        if (resultEl) {
            resultEl.className = "check-result-badge";
            resultEl.textContent = "Add reinforcement to generate a capacity curve first";
        }
        return { safe: false, capacityMu: null };
    }

    const capacityMu = findCapacityAtPu(curve, Pu);

    if (capacityMu === null) {
        if (resultEl) {
            resultEl.className = "check-result-badge unsafe";
            resultEl.textContent = `Pu = ${Pu} kN is outside the section's axial capacity range`;
        }
        return { safe: false, capacityMu: null };
    }

    const safe = Mu <= capacityMu;
    const utilization = capacityMu !== 0 ? (Mu / capacityMu) * 100 : 0;

    if (resultEl) {
        resultEl.className = `check-result-badge ${safe ? 'safe' : 'unsafe'}`;
        resultEl.textContent = safe
            ? `SAFE — Capacity Mu = ${capacityMu.toFixed(1)} kNm (${utilization.toFixed(0)}% utilized)`
            : `UNSAFE — Capacity Mu = ${capacityMu.toFixed(1)} kNm (demand exceeds capacity by ${(utilization - 100).toFixed(0)}%)`;
    }

    return { safe, capacityMu };
}

// Verify a user-supplied design point (Pu, Mu)
function checkDesignPoint() {
    const resultEl = document.getElementById("checkResult");
    const Pu = parseFloat(document.getElementById("checkPu").value);
    const Mu = parseFloat(document.getElementById("checkMu").value);

    if (isNaN(Pu) || isNaN(Mu)) {
        resultEl.className = "check-result-badge";
        resultEl.textContent = "Enter valid Pu & Mu values";
        designCheckPoint = null;
        if (calculatedCurve.length > 0) renderDiagramPlot();
        return;
    }

    const axis = document.getElementById("checkAxis").value;

    if (circles.length > 0 && (diagramsStale || calculatedCurve.length === 0)) {
        computeCurves();
    }

    designCheckPoint = { Pu, Mu, axis };

    if (circles.length === 0) {
        evaluateDesignCheckPoint();
        updateDiagramStatusUI();
        return;
    }

    renderDiagramPlot();
    updateDiagramStatusUI();
}

// Draw Strain and Stress profiles at current Xu
function renderStrainAndStressProfiles(ptData, activeDepth) {
    const currentDepth = activeDepth || maxY;
    document.getElementById("profileXu").textContent = `${ptData.Xu.toFixed(0)} mm`;
    document.getElementById("profilePu").textContent = `${ptData.CF.toFixed(1)} kN`;
    document.getElementById("profileMu").textContent = `${ptData.MOR.toFixed(1)} kNm`;

    const isDark = !document.body.classList.contains('light-theme');
    const textColor = isDark ? '#f3f4f6' : '#0f172a';
    const gridColor = isDark ? '#2d3748' : '#e2e8f0';
    const paperBg = isDark ? '#0b0f19' : '#f8fafc';

    const depthPoints = [];
    const strainPoints = [];
    const stressPoints = [];

    // Sample points along the active depth
    for (let y = 0; y <= currentDepth; y += currentDepth / 100) {
        depthPoints.push(y);
        const strain = linearStrainCompatibilityInColumn(currentDepth, ptData.Xu, y);
        strainPoints.push(strain);
        stressPoints.push(stressInConcreteAtStrain(strain));
    }

    // Strain Plot
    const strainTrace = {
        x: strainPoints,
        y: depthPoints,
        mode: 'lines',
        line: { color: '#8b5cf6', width: 3 },
        fill: 'tozerox',
        fillcolor: 'rgba(139, 92, 246, 0.15)'
    };

    const strainLayout = {
        title: { text: `Strain Profile (Depth: ${currentDepth}mm)`, font: { color: textColor, size: 11 } },
        paper_bgcolor: paperBg,
        plot_bgcolor: paperBg,
        xaxis: { gridcolor: gridColor, tickfont: { color: textColor, size: 10 }, tickformat: '.3f', tickangle: 0, nticks: 4, automargin: true },
        yaxis: { autorange: 'reversed', gridcolor: gridColor, tickfont: { color: textColor }, title: "Depth (mm)" },
        margin: { t: 40, r: 15, l: 45, b: 40 }
    };

    Plotly.newPlot("strainProfilePlot", [strainTrace], strainLayout, { staticPlot: true, responsive: true });

    // Stress Plot
    const stressTrace = {
        x: stressPoints,
        y: depthPoints,
        mode: 'lines',
        line: { color: '#10b981', width: 3 },
        fill: 'tozerox',
        fillcolor: 'rgba(16, 185, 129, 0.15)'
    };

    const stressLayout = {
        title: { text: "Concrete Stress (MPa)", font: { color: textColor, size: 11 } },
        paper_bgcolor: paperBg,
        plot_bgcolor: paperBg,
        xaxis: { gridcolor: gridColor, tickfont: { color: textColor, size: 10 }, tickangle: 0, nticks: 4, automargin: true },
        yaxis: { autorange: 'reversed', gridcolor: gridColor, tickfont: { color: textColor } },
        margin: { t: 40, r: 15, l: 30, b: 40 }
    };

    Plotly.newPlot("stressProfilePlot", [stressTrace], stressLayout, { staticPlot: true, responsive: true });
}

// Render calculated points list inside Tab 3 Table
function updateDataTable() {
    const tbody = document.getElementById("dataPointsTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    const axisSelect = document.getElementById("tableAxis");
    const axis = axisSelect ? axisSelect.value : "x";
    const curve = (sectionType === "circular" || axis === "x") ? curveX : curveY;
    const depth = (sectionType === "circular" || axis === "x") ? maxY : maxX;

    curve.forEach(pt => {
        const tr = document.createElement("tr");
        const xud = (pt.Xu / depth).toFixed(3);
        const ecc = pt.CF !== 0 ? (pt.MOR * 1000 / pt.CF).toFixed(1) : "∞";

        tr.innerHTML = `
            <td>${xud}</td>
            <td>${pt.Xu.toFixed(1)}</td>
            <td>${pt.CF.toFixed(2)}</td>
            <td>${pt.MOR.toFixed(2)}</td>
            <td>${ecc}</td>
        `;
        tbody.appendChild(tr);
    });
}

// Export data to CSV file
function exportToCSV() {
    const axisSelect = document.getElementById("tableAxis");
    const axis = axisSelect ? axisSelect.value : "x";
    const curve = (sectionType === "circular" || axis === "x") ? curveX : curveY;
    const depth = (sectionType === "circular" || axis === "x") ? maxY : maxX;

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Xu/d Ratio,Neutral Axis Xu (mm),Axial Force Pu (kN),Bending Moment Mu (kNm),Eccentricity e (mm)\n";

    curve.forEach(pt => {
        const xud = (pt.Xu / depth).toFixed(3);
        const ecc = pt.CF !== 0 ? (pt.MOR * 1000 / pt.CF).toFixed(1) : "∞";
        csvContent += `${xud},${pt.Xu.toFixed(1)},${pt.CF.toFixed(2)},${pt.MOR.toFixed(2)},${ecc}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `column_interaction_curve_${axis === "y" && sectionType !== "circular" ? "y-axis" : "x-axis"}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Realtime update triggers
function updateAll() {
    fck = parseFloat(document.getElementById("fck").value);
    fy = document.getElementById("fy").value;

    if (typeof renderSectionSvg === "function") {
        renderSectionSvg();
    }
    if (typeof updateRebarTable === "function") {
        updateRebarTable();
    }

    if (calculatedCurve.length > 0) {
        diagramsStale = true;
    }
    updateDiagramStatusUI();

    if (typeof cacheSectionToLocalStorage === "function") {
        cacheSectionToLocalStorage();
    }
}

let debounceTimer;
function debouncedUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(updateAll, 200);
}

// Initial setup on window load
window.onload = function() {
    if (typeof loadCachedSectionFromLocalStorage === "function") {
        loadCachedSectionFromLocalStorage();
    } else {
        updateAll();
    }
};
