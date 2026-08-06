// Section width-at-depth and rotation helpers. Depends on js/state.js (sectionType, maxX, maxY).
//
// getSectionWidthAtDepth is declared with `let` (not `const`) so that plot-3d.js can temporarily
// swap it out for a rotated-polygon version while sweeping neutral-axis angles, then restore the
// original afterwards - the same "swap globals, compute, restore" pattern already used by
// calculateInteractionDiagramForSection in interaction-diagram.js.
let getSectionWidthAtDepth = (y) => {
    if (sectionType === "circular") {
        const R = maxY / 2;
        if (y < 0 || y > maxY) return 0;
        return 2 * Math.sqrt(R * R - Math.pow(y - R, 2));
    } else {
        return maxX;
    }
};

// Rotate a point by `theta` radians about (cx, cy).
function rotatePoint(px, py, cx, cy, theta) {
    const dx = px - cx;
    const dy = py - cy;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    return {
        x: cx + dx * cos - dy * sin,
        y: cy + dx * sin + dy * cos
    };
}

// Rotate a rectangle (w x h, corner at origin) by theta about its own centroid, then shift so the
// topmost vertex sits at y=0 - matching the convention that y=0 is the extreme compression fibre.
// Returns { vertices, extent } where extent is the rotated bounding height (the new "D" to use for
// the strain-compatibility depth) and each vertex is { x, y } in the shifted frame.
function getRotatedRectVertices(w, h, theta) {
    const cx = w / 2, cy = h / 2;
    const corners = [
        { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }
    ].map(p => rotatePoint(p.x, p.y, cx, cy, theta));

    const minY = Math.min(...corners.map(p => p.y));
    const maxYv = Math.max(...corners.map(p => p.y));
    const vertices = corners.map(p => ({ x: p.x, y: p.y - minY }));

    return { vertices, extent: maxYv - minY };
}

// Width of a convex polygon (ordered vertices) at horizontal line y=const, found by intersecting
// every edge with that line and taking the span between the extreme intersection x-values.
function polygonWidthAtY(vertices, y) {
    const xs = [];
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % n];
        if (a.y === b.y) continue; // horizontal edge contributes no crossing
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        if (y < lo || y > hi) continue;
        const t = (y - a.y) / (b.y - a.y);
        xs.push(a.x + t * (b.x - a.x));
    }
    if (xs.length === 0) return 0;
    return Math.max(...xs) - Math.min(...xs);
}
