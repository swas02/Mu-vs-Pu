// index.html-only: disclaimer gate, theme/tab UI, section save/load, and the interactive SVG
// section editor (drawing, dragging, pattern generators). Depends on js/state.js and calls into
// plot-2d.js's updateAll()/debouncedUpdate() to refresh derived UI after edits.

// Dismiss the disclaimer gate - only entry point that reveals the app
function acknowledgeDisclaimer() {
    const overlay = document.getElementById("disclaimerOverlay");
    if (overlay) overlay.remove();
}

function toggleShapeInputs() {
    // 1. Save current profile details
    profiles[sectionType] = {
        circles: [...circles],
        maxX: parseInt(document.getElementById("maxX").value) || 350,
        maxY: parseInt(document.getElementById("maxY").value) || 450,
        fck: document.getElementById("fck").value,
        fy: document.getElementById("fy").value,
        cover: parseInt(document.getElementById("cover").value) || 40
    };

    // 2. Set new section type
    const newType = document.getElementById("shapeType").value;
    sectionType = newType;

    // 3. Load target profile details
    const profile = profiles[newType];
    circles = [...profile.circles];

    document.getElementById("maxX").value = profile.maxX;
    document.getElementById("maxY").value = profile.maxY;
    document.getElementById("fck").value = profile.fck;
    document.getElementById("fy").value = profile.fy;
    document.getElementById("cover").value = profile.cover;

    maxX = profile.maxX;
    maxY = profile.maxY;
    fck = parseFloat(profile.fck);
    fy = profile.fy;
    selectedBarIndex = null;

    // 4. Adapt layout inputs visibility
    const widthContainer = document.getElementById("widthInputContainer");
    const depthLabel = document.getElementById("depthLabel");
    const rectPattern = document.getElementById("rectPatternContainer");
    const circPattern = document.getElementById("circPatternContainer");

    if (newType === "circular") {
        widthContainer.style.display = "none";
        depthLabel.textContent = "Diameter (D, mm)";
        rectPattern.style.display = "none";
        circPattern.style.display = "block";
    } else {
        widthContainer.style.display = "block";
        depthLabel.textContent = "Depth (D, mm)";
        rectPattern.style.display = "grid";
        circPattern.style.display = "none";
    }
    debouncedUpdate();
}

// Serialize the current section, materials and reinforcement layout to a JSON file
function saveSection() {
    const sectionData = {
        version: 1,
        sectionType,
        fck: document.getElementById("fck").value,
        fy: document.getElementById("fy").value,
        cover: parseInt(document.getElementById("cover").value) || 40,
        dia: parseInt(document.getElementById("dia").value) || 16,
        color: document.getElementById("color").value,
        enableSnapping: document.getElementById("enableSnapping") ? document.getElementById("enableSnapping").checked : true,
        // Every bar's exact { dia, x, y, color } is saved here - the pattern-generator
        // inputs (numX/numY/numCirc) are just a placement shortcut, not real geometry,
        // so they're intentionally left out.
        reinforcementLocations: circles
    };

    // Use shape-native dimensions instead of the internal maxX/maxY names - a circular
    // section has no independent width (maxX is always forced equal to maxY), so it's
    // described by a radius instead.
    if (sectionType === "circular") {
        sectionData.radius = maxY / 2;
    } else {
        sectionData.b = maxX;
        sectionData.d = maxY;
    }

    const blob = new Blob([JSON.stringify(sectionData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mu-vs-pu-section-${sectionType}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Read a previously saved section file and hand it off for validation + loading
function loadSection(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = ""; // allow re-selecting the same file later

    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        let data;
        try {
            data = JSON.parse(e.target.result);
        } catch (err) {
            alert("That file isn't valid JSON — the section couldn't be loaded.");
            return;
        }

        const reinforcementLocations = data && (data.reinforcementLocations || data.circles);
        if (!data || (data.sectionType !== "rectangular" && data.sectionType !== "circular") || !Array.isArray(reinforcementLocations)) {
            alert("This doesn't look like a Mu vs Pu section file.");
            return;
        }

        applySection(data);
    };
    reader.onerror = function() {
        alert("Could not read the selected file.");
    };
    reader.readAsText(file);
}

// Restore section shape, materials, geometry and reinforcement from a loaded section file.
// Any previously generated diagram is invalidated - the user re-generates it explicitly.
function applySection(data) {
    sectionType = data.sectionType;
    const shapeEl = document.getElementById("shapeType");
    if (shapeEl) shapeEl.value = sectionType;

    // Prefer the shape-native fields (b/d, radius); fall back to maxX/maxY for files
    // saved before this rename.
    if (sectionType === "circular") {
        maxY = data.radius ? parseFloat(data.radius) * 2 : (parseInt(data.maxY) || 450);
        maxX = maxY;
    } else {
        maxY = data.d ? parseInt(data.d) : (parseInt(data.maxY) || 450);
        maxX = data.b ? parseInt(data.b) : (parseInt(data.maxX) || 350);
    }
    fck = parseFloat(data.fck) || 25;
    fy = ["Fe250", "Fe415", "Fe500", "Fe550"].includes(data.fy) ? data.fy : "Fe415";
    const cover = parseInt(data.cover) || 40;

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setVal("maxX", maxX);
    setVal("maxY", maxY);
    setVal("fck", fck);
    setVal("fy", fy);
    setVal("cover", cover);

    if (data.dia) setVal("dia", parseInt(data.dia) || 16);
    if (data.color) {
        setVal("color", data.color);
        const hexEl = document.getElementById("colorHex");
        if (hexEl) hexEl.textContent = String(data.color).toUpperCase();
    }
    const snapEl = document.getElementById("enableSnapping");
    if (snapEl) snapEl.checked = data.enableSnapping !== false;
    if (data.numX) setVal("numX", data.numX);
    if (data.numY) setVal("numY", data.numY);
    if (data.numCirc) setVal("numCirc", data.numCirc);

    const reinforcementLocations = data.reinforcementLocations || data.circles; // "circles" supported for files saved before the rename
    if (Array.isArray(reinforcementLocations)) {
        circles = reinforcementLocations.map(c => ({
            dia: parseInt(c.dia) || 16,
            x: parseFloat(c.x) || 0,
            y: parseFloat(c.y) || 0,
            color: typeof c.color === "string" ? c.color : "#3b82f6"
        }));
    }
    selectedBarIndex = null;

    profiles[sectionType] = { circles: [...circles], maxX, maxY, fck: String(fck), fy, cover };

    const widthContainer = document.getElementById("widthInputContainer");
    const depthLabel = document.getElementById("depthLabel");
    const rectPattern = document.getElementById("rectPatternContainer");
    const circPattern = document.getElementById("circPatternContainer");

    if (widthContainer && depthLabel && rectPattern && circPattern) {
        if (sectionType === "circular") {
            widthContainer.style.display = "none";
            depthLabel.textContent = "Diameter (D, mm)";
            rectPattern.style.display = "none";
            circPattern.style.display = "block";
        } else {
            widthContainer.style.display = "block";
            depthLabel.textContent = "Depth (D, mm)";
            rectPattern.style.display = "grid";
            circPattern.style.display = "none";
        }
    }

    purgeDiagramState();
    updateAll();
    cacheSectionToLocalStorage();
    if (typeof workerCachedAnimationSteps !== 'undefined') workerCachedAnimationSteps = null;
    if (typeof triggerBackgroundWorkerCalc === 'function') triggerBackgroundWorkerCalc();
}

// Serialize current section state for localStorage caching
function getCurrentSectionData() {
    const fckVal = document.getElementById("fck") ? document.getElementById("fck").value : String(fck);
    const fyVal = document.getElementById("fy") ? document.getElementById("fy").value : fy;
    const coverVal = document.getElementById("cover") ? parseInt(document.getElementById("cover").value) || 40 : 40;
    const diaVal = document.getElementById("dia") ? parseInt(document.getElementById("dia").value) || 16 : 16;
    const colorVal = document.getElementById("color") ? document.getElementById("color").value : "#3b82f6";
    const snappingVal = document.getElementById("enableSnapping") ? document.getElementById("enableSnapping").checked : true;

    const sectionData = {
        version: 1,
        sectionType: sectionType,
        fck: fckVal,
        fy: fyVal,
        cover: coverVal,
        dia: diaVal,
        color: colorVal,
        enableSnapping: snappingVal,
        reinforcementLocations: circles.map(c => ({ dia: c.dia, x: c.x, y: c.y, color: c.color }))
    };

    if (sectionType === "circular") {
        sectionData.radius = maxY / 2;
        sectionData.maxY = maxY;
        sectionData.maxX = maxY;
    } else {
        sectionData.b = maxX;
        sectionData.d = maxY;
        sectionData.maxX = maxX;
        sectionData.maxY = maxY;
    }

    return sectionData;
}

function cacheSectionToLocalStorage() {
    try {
        const data = getCurrentSectionData();
        localStorage.setItem("mu_vs_pu_cached_section", JSON.stringify(data));
    } catch (e) {
        console.warn("Could not save section to localStorage cache", e);
    }
}

function loadCachedSectionFromLocalStorage() {
    try {
        const raw = localStorage.getItem("mu_vs_pu_cached_section");
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data && (data.sectionType === "rectangular" || data.sectionType === "circular") && Array.isArray(data.reinforcementLocations || data.circles)) {
            applySection(data);
            return true;
        }
    } catch (e) {
        console.warn("Could not load cached section from localStorage", e);
    }
    return false;
}

// Listen for hex color value change to show on screen
const colorEl = document.getElementById("color");
if (colorEl) {
    colorEl.addEventListener("input", function(e) {
        const colorHexEl = document.getElementById("colorHex");
        if (colorHexEl) colorHexEl.textContent = e.target.value.toUpperCase();
    });
}

// Toggle Theme
function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    const themeIcon = document.getElementById('themeIcon');
    if (isLight) {
        themeIcon.innerHTML = `<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`;
    } else {
        themeIcon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
    }
    debouncedUpdate();
}

// Tab Switching
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    event.target.classList.add('active');
    document.getElementById(tabId).classList.add('active');
    activeTab = tabId;

    // Diagram calculation is manual (see generateDiagram) - just refresh the status banner here
    updateDiagramStatusUI();
}

// Draw Interactive SVG
function renderSectionSvg() {
    const svg = document.getElementById("sectionSvg");
    svg.innerHTML = "";

    maxX = parseInt(document.getElementById("maxX").value) || 350;
    maxY = parseInt(document.getElementById("maxY").value) || 450;
    if (sectionType === "circular") {
        maxX = maxY; // Circular columns have diameter D = maxY
    }

    const padding = 40;
    const containerSize = 400;
    const scale = Math.min((containerSize - 2 * padding) / maxX, (containerSize - 2 * padding) / maxY);

    const originX = (containerSize - maxX * scale) / 2;
    const originY = (containerSize - maxY * scale) / 2;

    const cover = parseInt(document.getElementById("cover").value) || 40;

    // Click listener for concrete body
    const onConcreteClick = (e) => {
        if (isDragging) return;
        const rect = svg.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) * (containerSize / rect.width);
        const clickY = (e.clientY - rect.top) * (containerSize / rect.height);

        let realX = Math.round((clickX - originX) / scale);
        let realY = Math.round((clickY - originY) / scale);

        realX = snapCoordinate(realX, maxX, realY, maxY);
        realY = snappedYGlobal;

        const dia = parseInt(document.getElementById("dia").value) || 16;
        const color = document.getElementById("color").value;

        if (sectionType === "circular") {
            const R = maxY / 2;
            const dist = Math.sqrt(Math.pow(realX - R, 2) + Math.pow(realY - R, 2));
            if (dist <= R) {
                circles.push({ dia, x: realX, y: realY, color });
                updateAll();
            }
        } else {
            if (realX >= 0 && realX <= maxX && realY >= 0 && realY <= maxY) {
                circles.push({ dia, x: realX, y: realY, color });
                updateAll();
            }
        }
    };

    if (sectionType === "circular") {
        const centerX = originX + (maxY / 2) * scale;
        const centerY = originY + (maxY / 2) * scale;
        const radius = (maxY / 2) * scale;

        // Draw concrete circle
        const concreteCirc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        concreteCirc.setAttribute("cx", centerX);
        concreteCirc.setAttribute("cy", centerY);
        concreteCirc.setAttribute("r", radius);
        concreteCirc.setAttribute("fill", "rgba(100, 116, 139, 0.15)");
        concreteCirc.setAttribute("stroke", "var(--text-primary)");
        concreteCirc.setAttribute("stroke-width", "2");
        concreteCirc.addEventListener("click", onConcreteClick);
        svg.appendChild(concreteCirc);

        // Draw cover guideline circle
        if (cover > 0 && cover < maxY / 2) {
            const coverCirc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            coverCirc.setAttribute("cx", centerX);
            coverCirc.setAttribute("cy", centerY);
            coverCirc.setAttribute("r", radius - cover * scale);
            coverCirc.setAttribute("fill", "none");
            coverCirc.setAttribute("stroke", "var(--text-muted)");
            coverCirc.setAttribute("stroke-dasharray", "4");
            coverCirc.setAttribute("stroke-width", "1");
            svg.appendChild(coverCirc);
        }
    } else {
        // Draw concrete core rectangle
        const concreteRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        concreteRect.setAttribute("x", originX);
        concreteRect.setAttribute("y", originY);
        concreteRect.setAttribute("width", maxX * scale);
        concreteRect.setAttribute("height", maxY * scale);
        concreteRect.setAttribute("fill", "rgba(100, 116, 139, 0.15)");
        concreteRect.setAttribute("stroke", "var(--text-primary)");
        concreteRect.setAttribute("stroke-width", "2");
        concreteRect.addEventListener("click", onConcreteClick);
        svg.appendChild(concreteRect);

        // Draw cover guideline rectangle
        if (cover > 0 && cover < maxX / 2 && cover < maxY / 2) {
            const coverRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            coverRect.setAttribute("x", originX + cover * scale);
            coverRect.setAttribute("y", originY + cover * scale);
            coverRect.setAttribute("width", (maxX - 2 * cover) * scale);
            coverRect.setAttribute("height", (maxY - 2 * cover) * scale);
            coverRect.setAttribute("fill", "none");
            coverRect.setAttribute("stroke", "var(--text-muted)");
            coverRect.setAttribute("stroke-dasharray", "4");
            coverRect.setAttribute("stroke-width", "1");
            svg.appendChild(coverRect);
        }
    }

    // Coordinate axes: origin (0,0) sits at the top-left of the section, X runs right, Y runs down
    const axisColor = "var(--text-secondary)";
    const axisExtend = 22; // px drawn into the padding beyond the section edges

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const arrowMarker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    arrowMarker.setAttribute("id", "axisArrow");
    arrowMarker.setAttribute("markerWidth", "8");
    arrowMarker.setAttribute("markerHeight", "8");
    arrowMarker.setAttribute("refX", "6");
    arrowMarker.setAttribute("refY", "3");
    arrowMarker.setAttribute("orient", "auto");
    const arrowHead = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrowHead.setAttribute("d", "M0,0 L0,6 L7,3 z");
    arrowHead.setAttribute("fill", axisColor);
    arrowMarker.appendChild(arrowHead);
    defs.appendChild(arrowMarker);
    svg.appendChild(defs);

    const xAxisLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    xAxisLine.setAttribute("x1", originX);
    xAxisLine.setAttribute("y1", originY);
    xAxisLine.setAttribute("x2", originX + maxX * scale + axisExtend);
    xAxisLine.setAttribute("y2", originY);
    xAxisLine.setAttribute("stroke", axisColor);
    xAxisLine.setAttribute("stroke-width", "1.5");
    xAxisLine.setAttribute("marker-end", "url(#axisArrow)");
    svg.appendChild(xAxisLine);

    const yAxisLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    yAxisLine.setAttribute("x1", originX);
    yAxisLine.setAttribute("y1", originY);
    yAxisLine.setAttribute("x2", originX);
    yAxisLine.setAttribute("y2", originY + maxY * scale + axisExtend);
    yAxisLine.setAttribute("stroke", axisColor);
    yAxisLine.setAttribute("stroke-width", "1.5");
    yAxisLine.setAttribute("marker-end", "url(#axisArrow)");
    svg.appendChild(yAxisLine);

    const xAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    xAxisLabel.setAttribute("x", originX + maxX * scale + axisExtend + 4);
    xAxisLabel.setAttribute("y", originY + 4);
    xAxisLabel.setAttribute("font-size", "11");
    xAxisLabel.setAttribute("fill", axisColor);
    xAxisLabel.textContent = "X";
    svg.appendChild(xAxisLabel);

    const yAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    yAxisLabel.setAttribute("x", originX - 4);
    yAxisLabel.setAttribute("y", originY + maxY * scale + axisExtend + 4);
    yAxisLabel.setAttribute("font-size", "11");
    yAxisLabel.setAttribute("fill", axisColor);
    yAxisLabel.setAttribute("text-anchor", "end");
    yAxisLabel.textContent = "Y";
    svg.appendChild(yAxisLabel);

    const originDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    originDot.setAttribute("cx", originX);
    originDot.setAttribute("cy", originY);
    originDot.setAttribute("r", "2.5");
    originDot.setAttribute("fill", axisColor);
    svg.appendChild(originDot);

    const originLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    originLabel.setAttribute("x", originX - 6);
    originLabel.setAttribute("y", originY - 6);
    originLabel.setAttribute("font-size", "10");
    originLabel.setAttribute("fill", axisColor);
    originLabel.setAttribute("text-anchor", "end");
    originLabel.textContent = "(0,0)";
    svg.appendChild(originLabel);

    // Snapping helper function
    function snapCoordinate(valX, maxValX, valY, maxValY) {
        const isSnapEnabled = document.getElementById("enableSnapping") ? document.getElementById("enableSnapping").checked : true;
        if (!isSnapEnabled) {
            snappedYGlobal = valY;
            return valX;
        }

        const cover = parseInt(document.getElementById("cover").value) || 40;
        const threshold = 15; // snap if within 15mm of cover line or boundaries
        const grid = 10; // otherwise snap to 10mm grid

        if (sectionType === "circular") {
            const R = maxValY / 2;
            const dx = valX - R;
            const dy = valY - R;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const R_cover = R - cover;

            if (Math.abs(dist - R_cover) < threshold && dist > 0) {
                const ratio = R_cover / dist;
                snappedYGlobal = Math.round(R + dy * ratio);
                return Math.round(R + dx * ratio);
            } else {
                snappedYGlobal = Math.round(valY / grid) * grid;
                return Math.round(valX / grid) * grid;
            }
        } else {
            let snappedX = valX;
            let snappedY = valY;

            if (Math.abs(valX - cover) < threshold) {
                snappedX = cover;
            } else if (Math.abs(valX - (maxValX - cover)) < threshold) {
                snappedX = maxValX - cover;
            } else {
                snappedX = Math.round(valX / grid) * grid;
            }

            if (Math.abs(valY - cover) < threshold) {
                snappedY = cover;
            } else if (Math.abs(valY - (maxValY - cover)) < threshold) {
                snappedY = maxValY - cover;
            } else {
                snappedY = Math.round(valY / grid) * grid;
            }

            snappedYGlobal = snappedY;
            return snappedX;
        }
    }

    // Handle SVG mouse movement to update coordinate label
    svg.addEventListener("mousemove", function(e) {
        const rect = svg.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) * (containerSize / rect.width);
        const mouseY = (e.clientY - rect.top) * (containerSize / rect.height);

        let realX = Math.round((mouseX - originX) / scale);
        let realY = Math.round((mouseY - originY) / scale);

        realX = snapCoordinate(realX, maxX, realY, maxY);
        realY = snappedYGlobal;

        if (sectionType === "circular") {
            const R = maxY / 2;
            const dist = Math.sqrt(Math.pow(realX - R, 2) + Math.pow(realY - R, 2));
            if (dist <= R) {
                document.getElementById("svgHoverInfo").textContent = `X: ${realX}mm | Y: ${realY}mm`;
            }
        } else {
            if (realX >= 0 && realX <= maxX && realY >= 0 && realY <= maxY) {
                document.getElementById("svgHoverInfo").textContent = `X: ${realX}mm | Y: ${realY}mm`;
            }
        }
    });

    // Draw rebars
    circles.forEach((circle, index) => {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");

        const cx = originX + circle.x * scale;
        const cy = originY + circle.y * scale;
        const r = (circle.dia / 2) * scale;

        c.setAttribute("cx", cx);
        c.setAttribute("cy", cy);
        c.setAttribute("r", Math.max(r, 4)); // minimum radius for visual selection
        c.setAttribute("fill", circle.color);
        c.setAttribute("stroke", selectedBarIndex === index ? "var(--text-primary)" : "rgba(0, 0, 0, 0.4)");
        c.setAttribute("stroke-width", selectedBarIndex === index ? "3" : "1");
        c.setAttribute("cursor", "move");
        c.style.transition = "stroke-width 0.1s";

        // Drag handlers
        const onDrag = (ev) => {
            isDragging = true;
            const rect = svg.getBoundingClientRect();
            const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;

            const mX = (clientX - rect.left) * (containerSize / rect.width);
            const mY = (clientY - rect.top) * (containerSize / rect.height);

            let xVal = Math.max(0, Math.min(maxX, Math.round((mX - originX) / scale)));
            let yVal = Math.max(0, Math.min(maxY, Math.round((mY - originY) / scale)));

            circle.x = snapCoordinate(xVal, maxX, yVal, maxY);
            circle.y = snappedYGlobal;

            c.setAttribute("cx", originX + circle.x * scale);
            c.setAttribute("cy", originY + circle.y * scale);

            // Live stats update while dragging
            updateRebarTable();
        };

        const stopDrag = () => {
            window.removeEventListener("mousemove", onDrag);
            window.removeEventListener("mouseup", stopDrag);
            window.removeEventListener("touchmove", onDrag);
            window.removeEventListener("touchend", stopDrag);

            setTimeout(() => { isDragging = false; }, 50);
            updateAll();
        };

        c.addEventListener("mousedown", (ev) => {
            ev.stopPropagation();
            selectedBarIndex = index;
            renderSectionSvg();
            window.addEventListener("mousemove", onDrag);
            window.addEventListener("mouseup", stopDrag);
        });

        c.addEventListener("touchstart", (ev) => {
            ev.stopPropagation();
            selectedBarIndex = index;
            renderSectionSvg();
            window.addEventListener("touchmove", onDrag);
            window.addEventListener("touchend", stopDrag);
        });

        g.appendChild(c);
        svg.appendChild(g);
    });
}

// Quick presets helpers
function setDia(val) {
    document.getElementById("dia").value = val;
}

function addFourCornerBars() {
    const cover = parseInt(document.getElementById("cover").value) || 40;
    const dia = parseInt(document.getElementById("dia").value) || 16;
    const color = document.getElementById("color").value;

    if (sectionType === "circular") {
        const R = maxY / 2;
        const R_bar = R - cover;
        circles.push({ dia, x: R, y: R - R_bar, color });
        circles.push({ dia, x: R, y: R + R_bar, color });
        circles.push({ dia, x: R - R_bar, y: R, color });
        circles.push({ dia, x: R + R_bar, y: R, color });
    } else {
        circles.push({ dia, x: cover, y: cover, color });
        circles.push({ dia, x: maxX - cover, y: cover, color });
        circles.push({ dia, x: cover, y: maxY - cover, color });
        circles.push({ dia, x: maxX - cover, y: maxY - cover, color });
    }

    updateAll();
}

// Delete Rebar listener on backspace/delete key
window.addEventListener("keydown", function(e) {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedBarIndex !== null) {
        circles.splice(selectedBarIndex, 1);
        selectedBarIndex = null;
        updateAll();
    }
});

// Add Single Rebar via Manual input
function addSingleRebar() {
    const dia = parseInt(document.getElementById("dia").value) || 16;
    const x = parseInt(document.getElementById("rebarX").value) || 0;
    const y = parseInt(document.getElementById("rebarY").value) || 0;
    const color = document.getElementById("color").value;

    if (x >= 0 && x <= maxX && y >= 0 && y <= maxY) {
        circles.push({ dia, x, y, color });
        updateAll();
    } else {
        alert("Rebar coordinates must sit inside the column bounds.");
    }
}

// Generate perimeter pattern
function generatePerimeterPattern() {
    const cover = parseInt(document.getElementById("cover").value) || 40;
    const dia = parseInt(document.getElementById("dia").value) || 16;
    const color = document.getElementById("color").value;
    const append = document.getElementById("appendPattern") ? document.getElementById("appendPattern").checked : false;

    if (!append) {
        circles = []; // Reset existing only if not appending
    }

    if (sectionType === "circular") {
        const numBars = parseInt(document.getElementById("numCirc").value) || 8;
        const R = maxY / 2;
        const R_bar = R - cover;
        for (let i = 0; i < numBars; i++) {
            const theta = (i * 2 * Math.PI) / numBars;
            const x = Math.round(R + R_bar * Math.cos(theta));
            const y = Math.round(R + R_bar * Math.sin(theta));
            circles.push({ dia, x, y, color });
        }
    } else {
        const numX = parseInt(document.getElementById("numX").value) || 3;
        const numY = parseInt(document.getElementById("numY").value) || 3;
        const startX = cover;
        const endX = maxX - cover;
        const startY = cover;
        const endY = maxY - cover;

        const stepX = numX > 1 ? (endX - startX) / (numX - 1) : 0;
        const stepY = numY > 1 ? (endY - startY) / (numY - 1) : 0;

        // Generate bars along top and bottom faces
        for (let i = 0; i < numX; i++) {
            circles.push({ dia, x: Math.round(startX + i * stepX), y: startY, color });
            circles.push({ dia, x: Math.round(startX + i * stepX), y: endY, color });
        }

        // Generate intermediate bars along sides (excluding corners already added)
        for (let j = 1; j < numY - 1; j++) {
            circles.push({ dia, x: startX, y: Math.round(startY + j * stepY), color });
            circles.push({ dia, x: endX, y: Math.round(startY + j * stepY), color });
        }
    }

    updateAll();
}

// Clear all reinforcement
function clearAllRebars() {
    circles = [];
    selectedBarIndex = null;
    purgeDiagramState(); // clearing is instant/cheap - no need to wait for a manual Generate click
    updateAll();
}

// Delete specific rebar from table list
function deleteRebar(index) {
    circles.splice(index, 1);
    if (selectedBarIndex === index) selectedBarIndex = null;
    updateAll();
}

// Update tables and sidebar details
function updateRebarTable() {
    const tbody = document.getElementById("rebarTableBody");
    tbody.innerHTML = "";
    let totalAst = 0;

    circles.forEach((circle, index) => {
        const ast = (Math.PI / 4) * Math.pow(circle.dia, 2);
        totalAst += ast;

        const tr = document.createElement("tr");
        tr.style.backgroundColor = selectedBarIndex === index ? "rgba(59, 130, 246, 0.1)" : "";
        tr.innerHTML = `
            <td><span style="color: ${circle.color}; font-size: 1.2rem;">●</span></td>
            <td>${circle.dia}</td>
            <td>${circle.x}</td>
            <td>${circle.y}</td>
            <td><button class="delete-btn" onclick="deleteRebar(${index})">Delete</button></td>
        `;
        tr.addEventListener("click", () => {
            selectedBarIndex = index;
            renderSectionSvg();
        });
        tbody.appendChild(tr);
    });

    // Calculate concrete cross section area
    const Ag = sectionType === "circular" ? (Math.PI / 4) * maxY * maxY : maxX * maxY;
    const pt = (totalAst / Ag) * 100;

    document.getElementById("statAst").textContent = `${Math.round(totalAst)} mm²`;
    document.getElementById("statRatio").textContent = `${pt.toFixed(2)}%`;
}
