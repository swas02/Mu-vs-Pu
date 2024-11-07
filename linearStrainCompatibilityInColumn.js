// Linear Strain Compatibility In Column
// Documentation 
// function  linearStrainCompatibilityInColumn: (d: number, Xu: number, x: number) => number

const linearStrainCompatibilityInColumn = (d, Xu, x) => {
    // Here 'd' is the depth of cross section.
    // 'Xu' is the depth of neutral axis
    // 'x' is the depth where strain is to be 
    let εx

    // Check for empty, null, or undefined values
    if (d === undefined || d === null || Xu === undefined || Xu === null || x === undefined || x === null) {
        throw new Error("Values cannot be empty, null or undefined.");
    }

    // Check for non-numeric values (using isNaN for efficiency)
    if (isNaN(d) || isNaN(Xu) || isNaN(x)) {
        throw new Error("All input values (d, Xu, x) must be numbers.");
    }

    // Check for negative values (if applicable to your specific requirements)
    if (d < 0 || Xu < 0 || x < 0) {
        throw new Error("Values of d, Xu and x cannot be negative.");
    }

    // Check for d being greater than zero (if applicable)
    if (d <= 0) {
        throw new Error("d should be greater than zero.");
    }

    // Continue
    if (Xu <= d) {
        εx = 0.0035 * (1 - (x / Xu))
        return εx
    }
    else if (Xu > d) {
        εx = 0.002 * (Xu - x) / (Xu - (3 / 7) * d);
        return εx
    } else
        throw Error('Aayein 🍆? \n Unknown Error is encountered')
}