// IS 456 material stress-strain relationships. Depends on js/state.js (fck, fy, Est).

// Core calculation logic: Linear Strain Compatibility
const linearStrainCompatibilityInColumn = (d, Xu, x) => {
    if (d === undefined || d === null || Xu === undefined || Xu === null || x === undefined || x === null) {
        throw new Error("Values cannot be empty, null or undefined.");
    }
    if (isNaN(d) || isNaN(Xu) || isNaN(x)) {
        throw new Error("All input values (d, Xu, x) must be numbers.");
    }
    if (d < 0 || Xu < 0 || x < 0) {
        throw new Error("Values of d, Xu and x cannot be negative.");
    }
    if (d <= 0) {
        throw new Error("d should be greater than zero.");
    }

    if (Xu <= d) {
        return 0.0035 * (1 - (x / Xu));
    } else {
        return 0.002 * (Xu - x) / (Xu - (3 / 7) * d);
    }
};

const stressInConcreteAtStrain = (strain) => {
    if (strain >= 0 && strain <= 0.002) {
        return 0.45 * fck * (2 * (strain / 0.002) - Math.pow((strain / 0.002), 2));
    } else if (strain > 0.002 && strain <= 0.0035) {
        return 0.45 * fck;
    } else {
        return 0; // tension ignored
    }
};

// Interpolation helper
const interpolate = (s1, s2, e1, e2, e) => s1 - (s1 - s2) * (e1 - e) / (e1 - e2);

// Generalized Steel stress evaluation based on IS 456
const stressInSteelAtStrain = (strain) => {
    const sign = strain < 0 ? -1 : 1;
    const ε = Math.abs(strain);

    if (fy === "Fe250") {
        const yieldStrain = 0.87 * 250 / Est;
        if (ε < yieldStrain) return sign * ε * Est;
        return sign * 0.87 * 250;
    } else if (fy === "Fe415") {
        if (ε >= 0 && ε < 0.00144) return sign * Est * ε;
        else if (ε >= 0.00144 && ε < 0.00163) return sign * interpolate(288.7, 306.7, 0.00144, 0.00163, ε);
        else if (ε >= 0.00163 && ε < 0.00192) return sign * interpolate(306.7, 324.8, 0.00163, 0.00192, ε);
        else if (ε >= 0.00192 && ε < 0.00241) return sign * interpolate(324.8, 342.8, 0.00192, 0.00241, ε);
        else if (ε >= 0.00241 && ε < 0.00276) return sign * interpolate(342.8, 351.8, 0.00241, 0.00276, ε);
        else if (ε >= 0.00276 && ε <= 0.00380) return sign * interpolate(351.8, 360.9, 0.00276, 0.00380, ε);
        else return sign * 360.9;
    } else if (fy === "Fe500") {
        // Fe500 SP16 points
        if (ε >= 0 && ε < 0.00174) return sign * Est * ε;
        else if (ε >= 0.00174 && ε < 0.00195) return sign * interpolate(347.8, 369.6, 0.00174, 0.00195, ε);
        else if (ε >= 0.00195 && ε < 0.00226) return sign * interpolate(369.6, 391.3, 0.00195, 0.00226, ε);
        else if (ε >= 0.00226 && ε < 0.00277) return sign * interpolate(391.3, 413.0, 0.00226, 0.00277, ε);
        else if (ε >= 0.00277 && ε < 0.00312) return sign * interpolate(413.0, 423.9, 0.00277, 0.00312, ε);
        else if (ε >= 0.00312 && ε <= 0.00418) return sign * interpolate(423.9, 435.0, 0.00312, 0.00418, ε);
        else return sign * 435.0;
    } else if (fy === "Fe550") {
        // Fe550 points
        if (ε >= 0 && ε < 0.00191) return sign * Est * ε;
        else if (ε >= 0.00191 && ε < 0.00215) return sign * interpolate(382.8, 406.5, 0.00191, 0.00215, ε);
        else if (ε >= 0.00215 && ε < 0.00249) return sign * interpolate(406.5, 430.4, 0.00215, 0.00249, ε);
        else if (ε >= 0.00249 && ε < 0.00305) return sign * interpolate(430.4, 454.3, 0.00249, 0.00305, ε);
        else if (ε >= 0.00305 && ε < 0.00343) return sign * interpolate(454.3, 466.3, 0.00305, 0.00343, ε);
        else if (ε >= 0.00343 && ε <= 0.00459) return sign * interpolate(466.3, 478.5, 0.00343, 0.00459, ε);
        else return sign * 478.5;
    }
    return 0;
};

// Nominal yield strength (MPa) parsed from the "FeXXX" grade label
const getFyValue = () => parseFloat(String(fy).replace(/[^0-9.]/g, "")) || 415;
